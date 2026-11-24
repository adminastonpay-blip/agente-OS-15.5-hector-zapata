import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { handleV21 } from "../src/routes/v21.ts";
import { enforceRequestBodyLimit } from "../src/security/request-guard.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const identity = (tenant: string) => ({
  actor: `actor-${tenant}`,
  method: "apikey" as const,
  tenant,
  roles: ["admin"],
  clearance: "confidential" as const,
});

function aiMock() {
  return {
    run: async () => ({ data: [[0.11, 0.22, 0.33]], response: "mock decision response" }),
  };
}

// v21 routes embeddings and decisions through ControlGate + ModelRunner.
// The mock must provide the same required bindings and both SafetyInterlock
// operations (policy evaluation and the SQLite-backed rate-limit check).
function inferenceEnv() {
  const safetyStub = {
    fetch: async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === "/rate-limit/check") return json({ allowed: true }, 200);
      return json({ status: "allowed" }, 200);
    },
  };
  return {
    EMBED_MODEL: "@cf/baai/bge-m3",
    CHAT_MODEL: "@cf/meta/llama-3.1-8b-instruct-fp8",
    INTERNAL_ASSERTION_SECRET: "test-only-internal-assertion-secret-32-bytes-minimum",
    INTERNAL_ASSERTION_KEY_ID: "test-key-v1",
    SAFETY: {
      idFromName: (_name: string) => "mock-safety",
      get: (_id: string) => safetyStub,
    },
  };
}

describe("RAG tenant isolation and request security — TDD Green Phase", () => {
  test("Tenant B must not retrieve Tenant A data; ingest and query must use tenant namespaces", async () => {
    const stored: any[] = [];
    const queryCalls: any[] = [];
    const persistedRows: any[] = [];
    const statusUpdates: any[] = [];
    const env: any = {
      ...inferenceEnv(),
      AI: aiMock(),
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            run: async () => {
              if (sql.includes("INSERT INTO documents")) persistedRows.push({ sql, args });
              if (sql.includes("UPDATE documents")) statusUpdates.push({ sql, args });
              return { success: true };
            },
          }),
        }),
      },
      VECTORIZE: {
        upsert: async (vectors: any[]) => {
          stored.push(...vectors);
          return { mutationId: "mock-upsert", count: vectors.length };
        },
        query: async (_vector: number[], options: any) => {
          queryCalls.push(options);
          const namespace = options?.namespace;
          const matches = stored
            .filter((item) => !namespace || item.namespace === namespace)
            .filter((item) => !options?.filter?.tenant?.$eq || item.metadata?.tenant === options.filter.tenant.$eq)
            .map((item) => ({ id: item.id, metadata: item.metadata, namespace: item.namespace }));
          return { matches };
        },
      },
    };

    const ingest = await handleV21(
      "/v1/rag/ingest",
      new Request("https://aston.test/v1/rag/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "secreto confidencial tenant A" }),
      }),
      env,
      identity("tenant-A"),
      json
    );
    assert.ok(ingest);
    const ingestPayload = await ingest.json() as any;
    const tenantADocumentIds = new Set<string>(ingestPayload.ids ?? []);

    const query = await handleV21(
      "/v1/rag/query",
      new Request("https://aston.test/v1/rag/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "secreto confidencial tenant A" }),
      }),
      env,
      identity("tenant-B"),
      json
    );
    assert.ok(query);
    const payload = await query.json() as any;

    const violations: string[] = [];
    if (stored.some((item) => item.namespace !== "tenant-A" || item.metadata?.tenant !== "tenant-A" || typeof item.metadata?.text !== "string")) {
      violations.push("ingest did not persist tenant-A namespace and tenant metadata with chunk text");
    }
    if (persistedRows.length === 0 || persistedRows.some((row) => !row.sql.includes("(id, tenant, source, chunk, created_at, index_status)") || row.args[1] !== "tenant-A" || row.args[5] !== "PENDING_VECTOR")) {
      violations.push("D1 document record was not persisted with the authenticated tenant");
    }
    if (queryCalls[0]?.namespace !== "tenant-B") {
      violations.push("query did not send Vectorize namespace=tenant-B");
    }
    if (queryCalls[0]?.filter?.tenant?.$eq !== "tenant-B") {
      violations.push("query did not send mandatory tenant metadata filter");
    }
    if (!statusUpdates.some((row) => row.args[0] === "INDEXED" && row.args[2] === "tenant-A")) {
      violations.push("D1 document status was not advanced to INDEXED after successful upsert");
    }
    if ((payload.matches ?? []).some((match: any) => tenantADocumentIds.has(match.id))) {
      violations.push("Tenant B received a document ID created by Tenant A");
    }
    assert.deepEqual(violations, [], violations.join("; "));
  });

  test("must mark the D1 document FAILED when Vectorize upsert fails", async () => {
    const statusUpdates: any[] = [];
    const env: any = {
      ...inferenceEnv(),
      AI: aiMock(),
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            run: async () => {
              if (sql.includes("UPDATE documents")) statusUpdates.push({ sql, args });
              return { success: true };
            },
          }),
        }),
      },
      VECTORIZE: {
        upsert: async () => { throw new Error("Vectorize unavailable"); },
      },
    };

    const response = await handleV21(
      "/v1/rag/ingest",
      new Request("https://aston.test/v1/rag/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "documento de prueba" }),
      }),
      env,
      identity("tenant-A"),
      json
    );

    assert.ok(response);
    assert.equal(response.status, 502);
    assert.ok(statusUpdates.some((row) => row.args[0] === "FAILED" && row.args[2] === "tenant-A"));
    const payload = await response.json() as any;
    assert.equal(payload.index_status, "FAILED");
  });

  test("must cap user-supplied topK at 20 before calling Vectorize", async () => {
    let receivedTopK: number | undefined;
    const env: any = {
      ...inferenceEnv(),
      AI: aiMock(),
      VECTORIZE: {
        query: async (_vector: number[], options: any) => {
          receivedTopK = options?.topK;
          return { matches: [] };
        },
      },
    };

    const response = await handleV21(
      "/v1/rag/query",
      new Request("https://aston.test/v1/rag/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "test", topK: 1_000_000 }),
      }),
      env,
      identity("tenant-B"),
      json
    );
    assert.ok(response);
    assert.ok(
      typeof receivedTopK === "number" && receivedTopK <= 20,
      `RAG permitió un topK de ${String(receivedTopK)}. Límite máximo esperado: 20.`
    );
  });

  test("must return a server error when D1 document persistence fails during ingest", async () => {
    const env: any = {
      ...inferenceEnv(),
      AI: aiMock(),
      DB: {
        prepare: (sql: string) => ({
          bind: (..._args: unknown[]) => ({
            run: async () => {
              if (sql.includes("INSERT INTO documents")) {
                throw new Error("DB Connection Failed");
              }
              return { success: true };
            },
          }),
        }),
      },
    };

    const response = await handleV21(
      "/v1/rag/ingest",
      new Request("https://aston.test/v1/rag/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "documento que requiere persistencia" }),
      }),
      env,
      identity("tenant-A"),
      json
    );
    assert.ok(response);
    assert.ok(
      response.status >= 500,
      `Se esperaba status 500 o superior, pero se recibió ${response.status}.`
    );
  });

  test("must reject a 5 MiB request at the same body-size guard used before RAG routing", async () => {
    const oversizedText = "x".repeat(5 * 1024 * 1024);
    const request = new Request("https://aston.test/v1/rag/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: oversizedText }),
    });
    const bounded = await enforceRequestBodyLimit(request, identity("tenant-A"));

    assert.equal(
      bounded.result.ok,
      false,
      "El guard permitió pasar un payload de 5 MiB al endpoint de ingesta"
    );
    assert.equal(bounded.result.limit, 64 * 1024);
  });

  test("Tenant B /v1/decide must query Vectorize with a mandatory tenant namespace", async () => {
    const queryCalls: any[] = [];
    const safetyStub = {
      fetch: async (url: string | URL) => {
        const path = new URL(String(url)).pathname;
        return path === "/rate-limit/check"
          ? json({ allowed: true }, 200)
          : json({ status: "allowed" }, 200);
      },
    };
    const env: any = {
      ...inferenceEnv(),
      AI: aiMock(),
      SAFETY: {
        idFromName: (_name: string) => "tenant-B-safety",
        get: (_id: string) => safetyStub,
      },
      VECTORIZE: {
        query: async (_vector: number[], options: any) => {
          queryCalls.push(options);
          return { matches: [] };
        },
      },
    };

    const response = await handleV21(
      "/v1/decide",
      new Request("https://aston.test/v1/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "¿Qué decisión corresponde?" }),
      }),
      env,
      identity("tenant-B"),
      json
    );

    assert.ok(response);
    assert.equal(queryCalls.length, 1, "La ruta /v1/decide no llegó a consultar Vectorize");
    assert.equal(
      queryCalls[0]?.namespace,
      "tenant-B",
      "La ruta /v1/decide consultó Vectorize sin el namespace obligatorio del tenant"
    );
    assert.deepEqual(
      queryCalls[0]?.filter,
      { tenant: { $eq: "tenant-B" } },
      "La ruta /v1/decide consultó Vectorize sin el filtro obligatorio de metadata tenant"
    );
  });
});

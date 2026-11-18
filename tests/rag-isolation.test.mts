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

describe("RAG tenant isolation and request security — TDD Red Phase", () => {
  test("Tenant B must not retrieve Tenant A data; ingest metadata and query filter must both be tenant-bound", async () => {
    const stored: any[] = [];
    const queryCalls: any[] = [];
    const env: any = {
      AI: aiMock(),
      DB: {
        prepare: (_sql: string) => ({
          bind: (..._args: unknown[]) => ({ run: async () => ({ success: true }) }),
        }),
      },
      VECTORIZE: {
        upsert: async (vectors: any[]) => {
          stored.push(...vectors);
          return { mutationId: "mock-upsert", count: vectors.length };
        },
        query: async (_vector: number[], options: any) => {
          queryCalls.push(options);
          const tenantFilter = options?.filter?.tenant?.$eq;
          const matches = stored
            .filter((item) => !tenantFilter || item.metadata?.tenant === tenantFilter)
            .map((item) => ({ id: item.id, metadata: item.metadata }));
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
    if (stored.some((item) => item.metadata?.tenant !== "tenant-A")) {
      violations.push("ingest did not persist tenant=tenant-A metadata");
    }
    if (queryCalls[0]?.filter?.tenant?.$eq !== "tenant-B") {
      violations.push("query did not send Vectorize filter tenant=$eq tenant-B");
    }
    if ((payload.matches ?? []).some((match: any) => tenantADocumentIds.has(match.id))) {
      violations.push("Tenant B received a document ID created by Tenant A");
    }
    assert.deepEqual(violations, [], violations.join("; "));
  });

  test("must cap user-supplied topK at 20 before calling Vectorize", async () => {
    let receivedTopK: number | undefined;
    const env: any = {
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

  test("Tenant B /v1/decide must query Vectorize with a mandatory tenant filter", async () => {
    const queryCalls: any[] = [];
    const safetyStub = {
      fetch: async () => json({ status: "allowed" }, 200),
    };
    const env: any = {
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
    assert.deepEqual(
      queryCalls[0]?.filter,
      { tenant: { $eq: "tenant-B" } },
      "La ruta /v1/decide consultó Vectorize sin el filtro obligatorio del tenant"
    );
  });
});

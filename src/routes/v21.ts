/**
 * ASTON OS 21.0 route surface — fail-closed Gate A enforcement.
 * Does not alter /chat contract.
 */
import type { Env, Identity } from "../types";
import { createObjectType, createObject, createLink, cascadeImpact } from "../ontology";
import { emitLineage, getLineageTree } from "../lineage";
import { maskForAgent } from "../pii";
import { embed, chat, chunk } from "../lib/ai";
import {
  canonicalizeJson,
  fromBase64Url,
  importEd25519PublicKey,
  signInternalAssertion,
  verifyEd25519ProofOfPossession,
  MAX_INTERNAL_ASSERTION_TTL_MS,
} from "../core/attestation";

type GateEnv = Env & {
  INTERNAL_ASSERTION_SECRET?: string;
  INTERNAL_ASSERTION_KEY_ID?: string;
};

// Vectorize namespaces are limited to 64 UTF-8 bytes. Derive only from
// the authenticated identity; never accept a namespace from the request body.
function tenantNamespace(identity: Identity): string | null {
  const tenant = identity.tenant?.trim();
  if (!tenant || new TextEncoder().encode(tenant).byteLength > 64) return null;
  return tenant;
}

function hasVerifiedIdentity(identity: Identity | undefined | null): identity is Identity {
  return Boolean(
    identity &&
      identity.method !== "public" &&
      typeof identity.tenant === "string" &&
      identity.tenant.trim().length > 0 &&
      typeof identity.actor === "string" &&
      identity.actor.trim().length > 0
  );
}

/**
 * Enforces Ed25519 Proof-of-Possession on verified requests.
 * Fails closed whenever PoP headers are missing, incomplete, mismatched, or invalid.
 */
async function verifyRequestProofOfPossession(
  req: Request,
  identity: Identity,
  rawBodyText: string
): Promise<{ ok: true } | { ok: false; status: 401 | 403; error: string }> {
  const sig = req.headers.get("x-aston-pop-signature")?.trim();
  const pubB64Url = req.headers.get("x-aston-pop-public-key")?.trim();
  const claimedActor = req.headers.get("x-aston-actor")?.trim();
  const claimedTenant = req.headers.get("x-aston-tenant")?.trim();

  if (claimedTenant && claimedTenant !== identity.tenant) {
    return { ok: false, status: 403, error: "tenant_header_mismatch" };
  }
  if (claimedActor && claimedActor !== identity.actor) {
    return { ok: false, status: 403, error: "actor_header_mismatch" };
  }
  if (!sig && !pubB64Url) {
    return { ok: false, status: 401, error: "pop_signature_required" };
  }
  if (!sig || !pubB64Url) {
    return { ok: false, status: 401, error: "incomplete_pop_headers" };
  }

  try {
    const pubKey = await importEd25519PublicKey(fromBase64Url(pubB64Url));
    const url = new URL(req.url);
    const popStatement = canonicalizeJson({
      method: req.method,
      path: url.pathname,
      tenant: identity.tenant,
      actor: identity.actor,
      body: rawBodyText,
    });
    const valid = await verifyEd25519ProofOfPossession(pubKey, popStatement, sig);
    if (!valid) {
      return { ok: false, status: 401, error: "invalid_ed25519_pop_signature" };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 401, error: "malformed_ed25519_pop" };
  }
}

async function buildInternalAssertionHeaders(
  env: GateEnv,
  aud: string,
  identity: Identity
): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; error: string }> {
  const secret = env.INTERNAL_ASSERTION_SECRET;
  const kid = env.INTERNAL_ASSERTION_KEY_ID;
  if (!secret || !kid) {
    return { ok: false, error: "internal_assertion_config_incomplete" };
  }
  try {
    const token = await signInternalAssertion(
      {
        iss: "v21-router",
        aud,
        sub_tenant: identity.tenant,
        sub_actor: identity.actor,
        jti: crypto.randomUUID(),
        ttlMs: MAX_INTERNAL_ASSERTION_TTL_MS,
      },
      secret,
      kid
    );
    return { ok: true, headers: { "x-aston-internal-assertion": token } };
  } catch {
    return { ok: false, error: "internal_assertion_sign_failed" };
  }
}

export function pillarStatus(env: Env) {
  return {
    ai: !!env.AI,
    session: !!env.SESSION,
    graph: !!env.GRAPH,
    supervisor: !!env.SUPERVISOR,
    agent: !!env.AGENT,
    simulation: !!env.SIMULATION,
    mission: !!env.MISSION,
    safety: !!env.SAFETY,
    d1: !!env.DB,
    vectorize: !!env.VECTORIZE,
    journal: !!env.JOURNAL,
    etl_queue: !!env.ETL_QUEUE,
    missions_queue: !!env.MISSIONS,
    hyperdrive: !!env.HYPERDRIVE,
  };
}

export async function handleV21(
  path: string,
  req: Request,
  env: GateEnv,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
  if (!hasVerifiedIdentity(identity)) {
    return json({ ok: false, error: "verified_identity_required" }, 403);
  }

  let rawBodyText: string | null = null;
  const readJsonBody = async <T = any>(): Promise<T> => {
    if (rawBodyText === null) {
      rawBodyText = await req.text().catch(() => "");
    }
    if (!rawBodyText) return {} as T;
    try {
      return JSON.parse(rawBodyText) as T;
    } catch {
      return {} as T;
    }
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    await readJsonBody();
  }
  const popCheck = await verifyRequestProofOfPossession(req, identity, rawBodyText ?? "");
  if (!popCheck.ok) {
    return json({ ok: false, error: popCheck.error }, popCheck.status);
  }

  if (path === "/v1/rag/ingest" && req.method === "POST") {
    const body = await readJsonBody<any>();
    const text = String(body.text || body.content || "").trim();
    const source = String(body.source || "upload").slice(0, 200);
    if (!text) return json({ ok: false, error: "text required" }, 400);
    const namespace = tenantNamespace(identity);
    if (!namespace) return json({ ok: false, error: "valid tenant namespace required" }, 403);
    if (!env.AI) return json({ ok: false, error: "AI required" }, 503);
    if (!env.DB) return json({ ok: false, error: "D1 binding required for RAG persistence" }, 503);
    if (!env.VECTORIZE) return json({ ok: false, error: "Vectorize binding required for tenant-isolated RAG" }, 503);

    const parts = chunk(text);
    const ids: string[] = [];
    for (const part of parts) {
      const id = `doc_${crypto.randomUUID()}`;
      ids.push(id);
      let vec: number[];
      try {
        const [embedding] = await embed(env, identity, [part]);
        if (!Array.isArray(embedding) || embedding.length === 0) throw new Error("empty_embedding");
        vec = embedding;
      } catch (error: any) {
        console.error("[RAG_EMBEDDING_AUTHORIZATION_OR_INFERENCE_FAILED]", error?.message || error);
        return json({ ok: false, error: "Embedding authorization or inference failed" }, 502);
      }

      try {
        await env.DB.prepare(
          `INSERT INTO documents (id, tenant, source, chunk, created_at, index_status) VALUES (?, ?, ?, ?, ?, ?)`
        )
          .bind(id, namespace, source, part, Date.now(), "PENDING_VECTOR")
          .run();
      } catch (error) {
        console.error("[RAG_D1_PERSISTENCE_FAILED]", error);
        return json({ ok: false, error: "Persistence failed" }, 500);
      }

      try {
        await env.VECTORIZE.upsert([
          {
            id,
            values: vec,
            namespace,
            metadata: { source, text: part, tenant: namespace },
          },
        ] as any);
      } catch (error: any) {
        console.error("[RAG_VECTORIZE_UPSERT_FAILED]", error?.message || error);
        try {
          await env.DB.prepare(
            "UPDATE documents SET index_status = ? WHERE id = ? AND tenant = ?"
          ).bind("FAILED", id, namespace).run();
        } catch (statusError) {
          console.error("[RAG_INDEX_STATUS_FAILED]", statusError);
        }
        return json({ ok: false, error: "Vector persistence failed", index_status: "FAILED" }, 502);
      }

      try {
        await env.DB.prepare(
          "UPDATE documents SET index_status = ? WHERE id = ? AND tenant = ?"
        ).bind("INDEXED", id, namespace).run();
      } catch (statusError) {
        console.error("[RAG_INDEX_STATUS_FAILED]", statusError);
        return json({ ok: false, error: "Index status update failed", index_status: "PENDING_VECTOR" }, 500);
      }

      await emitLineage(env, {
        tenant: identity.tenant,
        object_id: id,
        transformation: "rag_ingest",
        pipeline_version: "21.0",
        actor: identity.actor,
        metadata: { source },
      });
    }
    return json({ ok: true, chunks: ids.length, ids, vectorize: !!env.VECTORIZE, d1: !!env.DB });
  }

  if (path === "/v1/rag/query" && req.method === "POST") {
    const body = await readJsonBody<any>();
    const q = String(body.query || body.q || "").trim();
    if (!q) return json({ ok: false, error: "query required" }, 400);
    const namespace = tenantNamespace(identity);
    if (!namespace) return json({ ok: false, error: "valid tenant namespace required" }, 403);
    if (!env.VECTORIZE) {
      return json({
        ok: true,
        matches: [],
        note: "VECTORIZE not bound — configure index knowledge-base to enable semantic search",
      });
    }
    try {
      const [qvec] = await embed(env, identity, [q]);
      const requestedTopK = Number(body.topK ?? 5);
      const topK = Number.isFinite(requestedTopK)
        ? Math.min(20, Math.max(1, Math.floor(requestedTopK)))
        : 5;
      const m = await env.VECTORIZE.query(qvec, {
        topK,
        returnMetadata: "all",
        namespace,
        filter: { tenant: { $eq: namespace } },
      } as any);
      return json({ ok: true, matches: m.matches ?? [] });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e).slice(0, 200) }, 502);
    }
  }

  if (path === "/v1/ontology/types" && req.method === "POST") {
    const body = await readJsonBody<any>();
    if (!env.DB) return json({ ok: false, error: "DB binding required for ontology types", pillar: "ontology" }, 503);
    try {
      const id = await createObjectType(env, { name: body.name || "Entity", schema: body.schema || {} });
      return json({ ok: true, id });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }

  if (path === "/v1/ontology/objects" && req.method === "POST") {
    const body = await readJsonBody<any>();
    if (!env.DB || !env.GRAPH) return json({ ok: false, error: "DB + GRAPH required", pillar: "ontology" }, 503);
    try {
      const id = await createObject(env, identity, {
        type_id: body.type_id,
        properties: body.properties || {},
      });
      return json({ ok: true, id });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }

  if (path === "/v1/ontology/links" && req.method === "POST") {
    const body = await readJsonBody<any>();
    if (!env.DB || !env.GRAPH) return json({ ok: false, error: "DB + GRAPH required", pillar: "ontology" }, 503);
    try {
      const id = await createLink(env, identity, {
        from_id: body.from_id,
        to_id: body.to_id,
        type: body.type || "related",
        properties: body.properties,
      });
      return json({ ok: true, id });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }

  if (path === "/v1/ontology/impact" && req.method === "POST") {
    const body = await readJsonBody<any>();
    const namespace = tenantNamespace(identity);
    if (!namespace) return json({ ok: false, error: "valid tenant namespace required" }, 403);
    const rows = await cascadeImpact(env, namespace, body.root_id || body.id, body.at ?? Date.now());
    return json({ ok: true, impact: rows });
  }

  if (path === "/v1/graph/neighbors" && req.method === "GET") {
    if (!env.GRAPH) return json({ ok: false, error: "GRAPH DO not bound" }, 503);
    const namespace = tenantNamespace(identity);
    if (!namespace) return json({ ok: false, error: "valid tenant namespace required" }, 403);
    const u = new URL(req.url);
    const stub = env.GRAPH.get(env.GRAPH.idFromName(namespace));
    const id = u.searchParams.get("id") || "";
    const res = await stub.fetch(`https://do/neighbors?id=${encodeURIComponent(id)}`);
    return json({ ok: true, ...(await res.json<any>()) });
  }

  if (path === "/v1/graph/path" && req.method === "GET") {
    if (!env.GRAPH) return json({ ok: false, error: "GRAPH DO not bound" }, 503);
    const namespace = tenantNamespace(identity);
    if (!namespace) return json({ ok: false, error: "valid tenant namespace required" }, 403);
    const u = new URL(req.url);
    const stub = env.GRAPH.get(env.GRAPH.idFromName(namespace));
    const from = u.searchParams.get("from") || "";
    const to = u.searchParams.get("to") || "";
    const res = await stub.fetch(
      `https://do/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    );
    return json({ ok: true, ...(await res.json<any>()) });
  }

  if (path === "/v1/lineage" && req.method === "GET") {
    const u = new URL(req.url);
    const objectId = u.searchParams.get("object_id") || "";
    if (!objectId) return json({ ok: false, error: "object_id required" }, 400);
    const namespace = tenantNamespace(identity);
    if (!namespace) {
      return json({ ok: false, error: "tenant_required" }, 403);
    }
    const events = await getLineageTree(env, namespace, objectId);
    return json({ ok: true, events, d1: !!env.DB });
  }

  if (path === "/v1/swarm/plan" && req.method === "POST") {
    if (!env.SUPERVISOR) return json({ ok: false, error: "SUPERVISOR DO not bound" }, 503);
    const namespace = tenantNamespace(identity);
    if (!namespace) return json({ ok: false, error: "valid tenant namespace required" }, 403);
    const assertion = await buildInternalAssertionHeaders(env, "supervisor", identity);
    if (!assertion.ok) return json({ ok: false, error: assertion.error }, 503);
    const body = await readJsonBody<any>();
    const objective = String(body.objective || body.goal || "").trim();
    if (!objective) return json({ ok: false, error: "objective required" }, 400);
    const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(namespace));
    const res = await stub.fetch("https://do/plan", {
      method: "POST",
      headers: { "content-type": "application/json", ...assertion.headers },
      body: JSON.stringify({ objective, identity }),
    });
    const data = await res.json<any>();
    return json({ ok: res.ok, ...data }, res.status);
  }

  // Simulation twin: /init | /apply | /evaluate | /commit
  if (path.startsWith("/v1/simulation") && req.method === "POST") {
    if (!env.SIMULATION) return json({ ok: false, error: "SIMULATION DO not bound" }, 503);
    const namespace = tenantNamespace(identity);
    if (!namespace) return json({ ok: false, error: "valid tenant namespace required" }, 403);
    const assertion = await buildInternalAssertionHeaders(env, "simulation", identity);
    if (!assertion.ok) return json({ ok: false, error: assertion.error }, 503);
    const body = await readJsonBody<any>();
    const action = path === "/v1/simulation" ? body.action || "evaluate" : path.replace("/v1/simulation/", "");
    const doPath =
      action === "init"
        ? "/init"
        : action === "apply"
          ? "/apply"
          : action === "commit"
            ? "/commit"
            : "/evaluate";
    const stub = env.SIMULATION.get(env.SIMULATION.idFromName(namespace));
    const payload =
      doPath === "/commit"
        ? { identity }
        : doPath === "/evaluate"
          ? { question: body.question || body.scenario || body.message || "Evaluate risks", identity }
          : { ...body, identity };
    const res = await stub.fetch(`https://do${doPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...assertion.headers },
      body: JSON.stringify(payload),
    });
    const data = await res.json<any>().catch(() => ({}));
    return json({ ok: res.ok, ...data }, res.ok ? 200 : res.status);
  }

  // Mission brain: POST /run
  if (path === "/v1/mission" && req.method === "POST") {
    if (!env.MISSION) return json({ ok: false, error: "MISSION DO not bound" }, 503);
    const namespace = tenantNamespace(identity);
    if (!namespace) return json({ ok: false, error: "valid tenant namespace required" }, 403);
    const assertion = await buildInternalAssertionHeaders(env, "mission", identity);
    if (!assertion.ok) return json({ ok: false, error: assertion.error }, 503);
    const body = await readJsonBody<any>();
    const mission = {
      id: body.id || `m_${crypto.randomUUID()}`,
      origin: body.origin || "https://example.com",
      pool_id: body.pool_id || "",
      error_code: Number(body.error_code) || 0,
      severity: body.severity || "low",
      created_at: Date.now(),
      created_by: identity.actor,
      tenant: namespace,
    };
    const stub = env.MISSION.get(env.MISSION.idFromName(mission.id));
    const res = await stub.fetch("https://do/run", {
      method: "POST",
      headers: { "content-type": "application/json", ...assertion.headers },
      body: JSON.stringify(mission),
    });
    const data = await res.json<any>().catch(() => ({}));
    return json({ ok: res.ok, ...data }, res.ok ? 200 : res.status);
  }

  if (path === "/v1/safety/evaluate" && req.method === "POST") {
    if (!env.SAFETY) return json({ ok: false, error: "SAFETY DO not bound" }, 503);
    const namespace = tenantNamespace(identity);
    if (!namespace) return json({ ok: false, error: "valid tenant namespace required" }, 403);
    const assertion = await buildInternalAssertionHeaders(env, "safety-interlock", identity);
    if (!assertion.ok) return json({ ok: false, error: assertion.error }, 503);
    const body = await readJsonBody<any>();
    const stub = env.SAFETY.get(env.SAFETY.idFromName(namespace));
    const res = await stub.fetch("https://do/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json", ...assertion.headers },
      body: JSON.stringify({ action: body.action || body, identity }),
    });
    return json({ ok: true, ...(await res.json<any>()) });
  }

  if (path === "/v1/pii/mask" && req.method === "POST") {
    const body = await readJsonBody<any>();
    const text = String(body.text || "");
    const secret = env.PII_HMAC_SECRET;
    if (typeof secret !== "string" || new TextEncoder().encode(secret).byteLength < 32) {
      return json({ ok: false, error: "pii_hmac_secret_not_configured" }, 503);
    }
    const { masked } = await maskForAgent(text, identity.clearance, secret);
    return json({ ok: true, masked });
  }

  if (path === "/v1/audit" && req.method === "POST") {
    const body = await readJsonBody<any>();
    const namespace = tenantNamespace(identity);
    if (!namespace) return json({ ok: false, error: "valid tenant namespace required" }, 403);
    if (env.DB) {
      await env.DB.prepare(`INSERT INTO audit_log (ts, action, actor, detail) VALUES (?, ?, ?, ?)`)
        .bind(Date.now(), body.action || "event", identity.actor, JSON.stringify(body.detail || body))
        .run()
        .catch(() => {});
    }
    if (env.JOURNAL) {
      await env.JOURNAL.put(
        `audit/${Date.now()}-${crypto.randomUUID()}.json`,
        JSON.stringify({ ts: Date.now(), tenant: namespace, actor: identity.actor, body }),
        { httpMetadata: { contentType: "application/json" } }
      ).catch(() => {});
    }
    return json({ ok: true, persisted: { d1: !!env.DB, journal: !!env.JOURNAL } });
  }

  if (path === "/v1/etl/enqueue" && req.method === "POST") {
    const body = await readJsonBody<any>();
    if (!env.ETL_QUEUE) {
      return json({ ok: true, queued: false, note: "ETL_QUEUE not bound — dry-run", payload: body });
    }
    const namespace = tenantNamespace(identity);
    if (!namespace || !identity.actor?.trim()) {
      return json({ ok: false, error: "verified_tenant_identity_required" }, 403);
    }
    await env.ETL_QUEUE.send({ ...body, tenant: namespace, actor: identity.actor, ts: Date.now() });
    return json({ ok: true, queued: true });
  }

  if (path === "/v1/decide" && req.method === "POST") {
    const body = await readJsonBody<any>();
    const message = String(body.message || body.objective || "").trim();
    if (!message) return json({ ok: false, error: "message required" }, 400);
    const namespace = tenantNamespace(identity);
    if (!namespace) return json({ ok: false, error: "valid tenant namespace required" }, 403);
    if (!env.SAFETY) return json({ ok: false, error: "decision_safety_binding_unavailable" }, 503);
    const assertion = await buildInternalAssertionHeaders(env, "safety-interlock", identity);
    if (!assertion.ok) return json({ ok: false, error: assertion.error }, 503);
    try {
      const safetyStub = env.SAFETY.get(env.SAFETY.idFromName(namespace));
      const safetyResponse = await safetyStub.fetch("https://do/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json", ...assertion.headers },
        body: JSON.stringify({
          action: { tool: "decision_inference", args: { message_length: message.length }, context: { objective: "ASTON decision request" } },
          identity,
        }),
      


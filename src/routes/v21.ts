/**
 * ASTON OS 21.0 route surface — fail-closed Gate A enforcement.
 * Does not alter /chat contract.
 *
 * Restored after truncation that broke TypeScript ('}' expected).
 * Exports both handleV21 (path-based) and routeV21 (adapter for index.ts).
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

async function verifyRequestProofOfPossession(
  req: Request,
  identity: Identity,
  rawBodyText: string
): Promise<{ ok: true } | { ok: false; status: 401 | 403; error: string }> {
  const sig = req.headers.get("x-aston-pop-signature")?.trim();
  const pubB64Url = req.headers.get("x-aston-pop-public-key")?.trim();
  if (!sig && !pubB64Url) {
    return { ok: false, status: 401, error: "pop_signature_required" };
  }
  if (!sig || !pubB64Url) {
    return { ok: false, status: 401, error: "incomplete_pop_headers" };
  }
  if (identity.method === "public" || !identity.tenant || !identity.actor) {
    return { ok: false, status: 403, error: "verified_identity_required_for_pop" };
  }
  try {
    const pubKey = await importEd25519PublicKey(fromBase64Url(pubB64Url));
    const path = new URL(req.url).pathname;
    const statement = canonicalizeJson({
      method: req.method,
      path,
      tenant: identity.tenant,
      actor: identity.actor,
      body: rawBodyText,
    });
    const valid = await verifyEd25519ProofOfPossession(pubKey, statement, sig);
    if (!valid) return { ok: false, status: 401, error: "invalid_ed25519_pop_signature" };
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
  if (!secret || !kid) return { ok: false, error: "internal_assertion_secret_or_kid_missing" };
  if (!identity.tenant || !identity.actor) return { ok: false, error: "verified_identity_required" };
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
    const vectors = await embed(env, identity, parts);
    const ids: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      await env.DB.prepare(
        `INSERT INTO rag_documents (id, tenant, source, chunk_index, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(id, namespace, source, i, parts[i], Date.now())
        .run()
        .catch(() => {});
      await env.VECTORIZE.upsert([
        {
          id,
          values: vectors[i],
          namespace,
          metadata: { tenant: namespace, source, text: parts[i].slice(0, 500) },
        },
      ]);
    }
    await emitLineage(env, {
      tenant: namespace,
      object_id: ids[0] || source,
      transformation: "rag.ingest",
      pipeline_version: "v15.5",
      actor: identity.actor,
      metadata: { chunks: parts.length, source },
    }).catch(() => {});
    return json({ ok: true, chunks: parts.length, ids });
  }

  if (path === "/v1/rag/query" && req.method === "POST") {
    const body = await readJsonBody<any>();
    const query = String(body.query || body.q || "").trim();
    if (!query) return json({ ok: false, error: "query required" }, 400);
    const namespace = tenantNamespace(identity);
    if (!namespace) return json({ ok: false, error: "valid tenant namespace required" }, 403);
    if (!env.VECTORIZE || !env.AI) return json({ ok: false, error: "VECTORIZE and AI required" }, 503);
    const [qvec] = await embed(env, identity, [query]);
    const results = await env.VECTORIZE.query(qvec, {
      topK: Number(body.topK) || 5,
      returnMetadata: "all",
      namespace,
      filter: { tenant: { $eq: namespace } },
    } as any);
    return json({ ok: true, matches: results.matches ?? [], namespace });
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
          action: {
            tool: "decision_inference",
            args: { message_length: message.length },
            context: { objective: "ASTON decision request" },
          },
          identity,
        }),
      });
      const safetyResult = await safetyResponse.json<any>().catch(() => ({}));
      if (!safetyResponse.ok || safetyResult.status !== "allowed") {
        return json(
          { ok: false, error: "decision_blocked_by_safety_interlock", policy: safetyResult.policy },
          safetyResponse.ok ? 403 : 503
        );
      }
    } catch {
      return json({ ok: false, error: "decision_safety_unavailable" }, 503);
    }
    let context = "";
    if (env.VECTORIZE && env.AI) {
      try {
        const [qvec] = await embed(env, identity, [message]);
        const results = await env.VECTORIZE.query(qvec, {
          topK: 3,
          returnMetadata: "all",
          namespace,
          filter: { tenant: { $eq: namespace } },
        } as any);
        context = (results.matches ?? []).map((x: any) => x.metadata?.text).filter(Boolean).join("\n---\n");
      } catch { /* ignore */ }
    }
    const out = await chat(env, identity, [
      {
        role: "system",
        content: "ASTON OS decision engine. Sé concreto. Si hay contexto RAG, úsalo; no inventes hechos.",
      },
      ...(context
        ? [{ role: "user" as const, content: `Contexto:\n${context}\n\nPregunta: ${message}` }]
        : [{ role: "user" as const, content: message }]),
    ]);
    if (env.DB) {
      await env.DB.prepare(`INSERT INTO audit_log (ts, action, actor, detail) VALUES (?, ?, ?, ?)`)
        .bind(Date.now(), "decide", identity.actor, JSON.stringify({ message: message.slice(0, 200), tenant: namespace }))
        .run()
        .catch(() => {});
    }
    return json({ ok: true, answer: out.response, model: out.model, rag: !!context, version: "21.0-edge" });
  }

  return null;
}

/** Adapter expected by src/index.ts */
export async function routeV21(
  req: Request,
  env: GateEnv,
  _ctx: ExecutionContext,
  identity: Identity,
  _opts?: {
    createInternalAssertion?: (
      aud: string,
      id: Identity
    ) => Promise<{ ok: true; headers: Record<string, string> } | { ok: false; error: string }>;
  }
): Promise<Response> {
  const url = new URL(req.url);
  let path = url.pathname;
  if (path === "/v21") path = "/v1/capabilities";
  else if (path.startsWith("/v21/")) path = "/v1/" + path.slice("/v21/".length);

  const json = (d: unknown, s = 200): Response =>
    Response.json(d, { status: s, headers: { "cache-control": "no-store" } });

  const result = await handleV21(path, req, env, identity, json);
  if (result) return result;
  return json({ ok: false, error: "not_found", path }, 404);
}

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

function tenantNamespace(identity: Identity): string | null {
  const tenant = identity.tenant?.trim();
  if (!tenant || new TextEncoder().encode(tenant).byteLength > 64) return null;
  return tenant;
}

function hasVerifiedIdentity(identity: Identity | undefined | null): identity is Identity {
  return Boolean(
    identity &&
      identity.method !== "public" &&
      identity.actor?.trim() &&
      identity.tenant?.trim()
  );
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
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
  return { ontology: !!env.DB, rag: !!(env.VECTORIZE && env.AI), safety: !!env.SAFETY, lineage: !!env.DB };
}

export async function handleV21(
  req: Request,
  env: GateEnv,
  _ctx: ExecutionContext,
  identity: Identity
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const readJsonBody = async <T,>(): Promise<T> => {
    try { return (await req.json()) as T; } catch { return {} as T; }
  };

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
      { role: "system", content: "ASTON OS decision engine. Sé concreto. Si hay contexto RAG, úsalo; no inventes hechos." },
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

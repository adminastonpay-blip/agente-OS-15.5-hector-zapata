import type { Env, Identity } from "./types";
import { handleETLQueue } from "./etl";
import { handleETLIngest } from "./etl-ingest";
import { ControlGate, consumeInferencePermit, type ChatMessage } from "./core/control-gate";
import { ModelRunner } from "./core/model-runner";
import { SessionMemory } from "./do/session";
import { GraphResolver } from "./do/graph-do";
import { Supervisor } from "./do/supervisor";
import { AgentNode } from "./do/agent-node";
import { SimulationTwin } from "./do/simulation";
import { MissionBrain } from "./do/mission-brain";
import { SafetyInterlock } from "./do/safety-interlock";
import { TrustFabric } from "./do/trust-fabric";
import { RecoveryWorkflow } from "./workflows/recovery";
import { MissionTokenVerifier, hashRecoveryMission } from "./core/mission-token";
import { isAllowedRecoveryOrigin } from "./security/recovery-guard";
import { ReplayGuard } from "./core/replay-guard";
import {
  canonicalizeJson,
  fromBase64Url,
  importEd25519PublicKey,
  signInternalAssertion,
  verifyEd25519ProofOfPossession,
  MAX_INTERNAL_ASSERTION_TTL_MS,
} from "./core/attestation";
import { routeV21 } from "./routes/v21";

export {
  SessionMemory,
  GraphResolver,
  Supervisor,
  AgentNode,
  SimulationTwin,
  MissionBrain,
  SafetyInterlock,
  TrustFabric,
  RecoveryWorkflow,
  ReplayGuard,
};

export interface QueueMessageBatch<Body = unknown> {
  queue: string;
  messages: Array<{
    id: string;
    timestamp: Date;
    body: Body;
    ack(): void;
    retry(): void;
  }>;
}

type GateWorkerEnv = Env & {
  INTERNAL_ASSERTION_SECRET?: string;
  INTERNAL_ASSERTION_KEY_ID?: string;
};

/** Explicit allow-list of paths that may be served without PoP. */
const PUBLIC_OR_READ_PATHS = new Set([
  "/",
  "/health",
  "/v1/capabilities",
  "/v1/models",
  "/v1/voice/profiles",
]);

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...(extraHeaders ?? {}),
    },
  });
}

function resolveRequestIdentity(req: Request, env: Env): Identity {
  const accessEmail = req.headers.get("cf-access-authenticated-user-email")?.trim();
  const actorHeader = req.headers.get("x-aston-actor")?.trim();
  const tenantHeader = req.headers.get("x-aston-tenant")?.trim();
  const method = req.method.toUpperCase();

  if (accessEmail) {
    const tenant = tenantHeader || (env as Record<string, string | undefined>).DEFAULT_TENANT || "default";
    return {
      actor: accessEmail,
      method: "access",
      tenant,
      roles: ["operator", "authenticated"],
      clearance: "confidential",
    };
  }

  if (actorHeader && tenantHeader && (method === "GET" || method === "HEAD")) {
    return {
      actor: actorHeader,
      method: "session",
      tenant: tenantHeader,
      roles: ["reader"],
      clearance: "internal",
    };
  }

  return {
    actor: "anonymous",
    method: "public",
    tenant: "default",
    roles: [],
    clearance: "public",
  };
}

/**
 * Proof-of-Possession gate (fail-closed).
 *
 * Rules:
 * - Paths in PUBLIC_OR_READ_PATHS may omit PoP (health, capabilities, etc.).
 * - Any other path with a non-public identity MUST present a complete,
 *   valid Ed25519 PoP (signature + public key).
 * - Incomplete headers are always rejected.
 * - Tenant/actor header mismatches are always rejected.
 */
async function verifyWorkerPopIfPresent(
  req: Request,
  identity: Identity,
  path: string
): Promise<{ ok: true } | { ok: false; status: 401 | 403; error: string }> {
  const sig = req.headers.get("x-aston-pop-signature")?.trim();
  const pubB64Url = req.headers.get("x-aston-pop-public-key")?.trim();
  const claimedTenant = req.headers.get("x-aston-tenant")?.trim();
  const claimedActor = req.headers.get("x-aston-actor")?.trim();

  // Header consistency checks always apply when present.
  if (claimedTenant && identity.tenant && claimedTenant !== identity.tenant) {
    return { ok: false, status: 403, error: "tenant_header_mismatch" };
  }
  if (claimedActor && identity.actor && claimedActor !== identity.actor) {
    return { ok: false, status: 403, error: "actor_header_mismatch" };
  }

  const isPublicPath = PUBLIC_OR_READ_PATHS.has(path);
  const hasAnyPopHeader = Boolean(sig || pubB64Url);
  const hasCompletePop = Boolean(sig && pubB64Url);

  // Incomplete PoP headers are never accepted.
  if (hasAnyPopHeader && !hasCompletePop) {
    return { ok: false, status: 401, error: "incomplete_pop_headers" };
  }

  // Public allow-list paths may omit PoP entirely.
  if (isPublicPath && !hasAnyPopHeader) {
    return { ok: true };
  }

  // Non-public identity on a protected path requires complete PoP.
  if (!isPublicPath && identity.method !== "public") {
    if (!hasCompletePop) {
      return { ok: false, status: 401, error: "pop_signature_required" };
    }
  }

  // If PoP is present, it must be cryptographically valid and bound to a verified identity.
  if (hasCompletePop) {
    if (identity.method === "public" || !identity.tenant || !identity.actor) {
      return { ok: false, status: 403, error: "verified_identity_required_for_pop" };
    }

    try {
      const pubKey = await importEd25519PublicKey(fromBase64Url(pubB64Url!));
      const rawBody =
        req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text().catch(() => "");
      const statement = canonicalizeJson({
        method: req.method,
        path,
        tenant: identity.tenant,
        actor: identity.actor,
        body: rawBody,
      });
      const valid = await verifyEd25519ProofOfPossession(pubKey, statement, sig!);
      if (!valid) {
        return { ok: false, status: 401, error: "invalid_ed25519_pop_signature" };
      }
      return { ok: true };
    } catch {
      return { ok: false, status: 401, error: "malformed_ed25519_pop" };
    }
  }

  // Remaining case: public identity on a non-public path without PoP.
  // Downstream handlers already reject public identity on protected routes;
  // we do not open the door here.
  return { ok: true };
}

async function createWorkerInternalAssertion(
  env: GateWorkerEnv,
  aud: string,
  identity: Identity
): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; error: string }> {
  const secret = env.INTERNAL_ASSERTION_SECRET;
  const kid = env.INTERNAL_ASSERTION_KEY_ID;
  if (!secret || !kid) {
    return { ok: false, error: "internal_assertion_secret_or_kid_missing" };
  }
  if (!identity.tenant || !identity.actor) {
    return { ok: false, error: "verified_identity_required" };
  }
  try {
    const token = await signInternalAssertion(
      {
        iss: "worker-router",
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

export default {
  async fetch(req: Request, env: GateWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const identity = resolveRequestIdentity(req, env);

    const popCheck = await verifyWorkerPopIfPresent(req, identity, path);
    if (!popCheck.ok) {
      return jsonResponse({ ok: false, error: popCheck.error }, popCheck.status);
    }

    if (path === "/" || path === "/health") {
      return jsonResponse({
        ok: true,
        service: "aston-os",
        version: "15.5",
        trust_fabric: "gate-a-enforced",
        timestamp: new Date().toISOString(),
      });
    }

    if (path === "/v1/capabilities") {
      return jsonResponse({
        ok: true,
        runtime: "cloudflare-workers-do",
        attestation: {
          pop_algorithm: "Ed25519",
          internal_assertion_alg: "HS256",
          max_internal_assertion_ttl_ms: MAX_INTERNAL_ASSERTION_TTL_MS,
        },
      });
    }

    if (path === "/v1/ingest" && req.method === "POST") {
      if (identity.method === "public") {
        return jsonResponse({ ok: false, error: "verified_identity_required" }, 403);
      }
      return handleETLIngest(req, env, identity);
    }

    if (path === "/v1/chat" && req.method === "POST") {
      if (identity.method === "public") {
        return jsonResponse({ ok: false, error: "verified_chat_identity_required" }, 403);
      }
      const body = await req.json<{ messages?: ChatMessage[] }>().catch(() => null);
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const gate = new ControlGate(env);
      const decision = await gate.authorizeChat(identity, messages);
      if (!decision.ok) {
        return jsonResponse(
          { ok: false, error: decision.reason, policy: decision.policy },
          decision.status
        );
      }
      const serialized = JSON.stringify(messages);
      const model = env.CHAT_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
      if (!consumeInferencePermit(decision.permit, "chat", serialized, model)) {
        return jsonResponse({ ok: false, error: "inference_permit_invalid_or_expired" }, 403);
      }
      const runner = new ModelRunner(env);
      const output = await runner.runChat(messages, model);
      return jsonResponse({ ok: true, model, output });
    }

    if (path.startsWith("/v21/") || path === "/v21") {
      return routeV21(req, env, ctx, identity, {
        createInternalAssertion: (aud, id) => createWorkerInternalAssertion(env, aud, id),
      });
    }

    if (path === "/v1/recovery/mission" && req.method === "POST") {
      const origin = req.headers.get("origin");
      if (!isAllowedRecoveryOrigin(origin, env)) {
        return jsonResponse({ ok: false, error: "recovery_origin_not_allowed" }, 403);
      }
      const verifier = new MissionTokenVerifier(env);
      const tokenHeader = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
      const verified = await verifier.verify(tokenHeader);
      if (!verified.ok) {
        return jsonResponse({ ok: false, error: verified.reason }, 401);
      }
      const body = await req.json<{ actionContent?: string }>().catch(() => null);
      const actionContent = typeof body?.actionContent === "string" ? body.actionContent : "";
      const gate = new ControlGate(env);
      const claimed = await gate.consumeMissionToken(verified.payload);
      if (!claimed.ok) {
        return jsonResponse({ ok: false, error: claimed.reason }, claimed.status);
      }
      const authz = await gate.authorizeAction(verified.payload, actionContent);
      if (!authz.ok) {
        return jsonResponse(
          { ok: false, error: authz.reason, policy: authz.policy },
          authz.status
        );
      }
      const missionHash = await hashRecoveryMission(verified.payload.missionId, actionContent);
      return jsonResponse({
        ok: true,
        mission_id: verified.payload.missionId,
        mission_hash: missionHash,
      });
    }

    if (path.startsWith("/v1/trust/") || path === "/v1/decide" || path === "/v1/safety/evaluate") {
      if (identity.method === "public") {
        return jsonResponse({ ok: false, error: "verified_identity_required" }, 403);
      }
      const assertion = await createWorkerInternalAssertion(env, "trust-fabric", identity);
      if (!assertion.ok) {
        return jsonResponse({ ok: false, error: assertion.error }, 503);
      }
      if (!env.TRUST) {
        return jsonResponse({ ok: false, error: "trust_fabric_binding_unavailable" }, 503);
      }
      const stub = env.TRUST.get(env.TRUST.idFromName("trust:" + identity.tenant));
      const proxiedHeaders = new Headers(req.headers);
      proxiedHeaders.set("x-aston-internal-assertion", assertion.headers["x-aston-internal-assertion"]);
      proxiedHeaders.set("x-aston-verified-tenant", identity.tenant);
      proxiedHeaders.set("x-aston-verified-actor", identity.actor);
      return stub.fetch(
        new Request(req.url, {
          method: req.method,
          headers: proxiedHeaders,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        })
      );
    }

    return jsonResponse({ ok: false, error: "not_found", path }, 404);
  },

  async queue(batch: QueueMessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleETLQueue(batch as any, env, ctx);
  },
} satisfies ExportedHandler<GateWorkerEnv>;

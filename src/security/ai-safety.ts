import type { Env, Identity } from "../types";

export type AiSafetyResult =
  | { ok: true }
  | { ok: false; status: number; error: string; policy?: unknown };

const AI_SAFETY_TOOLS = new Set([
  "chat_completion",
  "decision_inference",
  "recovery_hypothesis",
  "tts_synthesis",
  "voice_synthesis",
  "rag_ingest_embedding",
  "rag_query_embedding",
]);

function isResolvedIdentity(identity: Identity | undefined): identity is Identity {
  if (!identity || typeof identity.actor !== "string" || !identity.actor ||
      typeof identity.tenant !== "string" || !identity.tenant ||
      !Array.isArray(identity.roles) ||
      !identity.roles.every((role) => typeof role === "string") ||
      !["public", "internal", "confidential", "secret"].includes(identity.clearance) ||
      !["access", "apikey", "sensor", "public"].includes(identity.method)) {
    return false;
  }

  // Public routes may use only the canonical anonymous principal. A public
  // identity must never be a caller-controlled way to claim another tenant/role.
  if (identity.method === "public") {
    return identity.actor === "public" &&
      identity.tenant === "public" &&
      identity.clearance === "public" &&
      identity.roles.length === 1 &&
      identity.roles[0] === "viewer";
  }

  return identity.actor !== "public" && identity.tenant !== "public";
}

/**
 * Mandatory preflight for model calls that consume user- or workflow-supplied text.
 * The caller must pass the identity resolved by the API authentication boundary.
 * Public endpoints may pass only the canonical anonymous principal.
 * Missing identity/binding, transport errors, and non-allow decisions fail closed.
 */
export async function evaluateAiSafety(
  env: Pick<Env, "SAFETY">,
  identity: Identity | undefined,
  tool: string,
  content: string,
  objective: string
): Promise<AiSafetyResult> {
  if (!isResolvedIdentity(identity)) {
    return { ok: false, status: 503, error: "ai_safety_resolved_identity_unavailable" };
  }
  if (!AI_SAFETY_TOOLS.has(tool)) {
    return { ok: false, status: 503, error: "ai_safety_tool_not_allowlisted" };
  }
  if (!env.SAFETY) return { ok: false, status: 503, error: "ai_safety_binding_unavailable" };
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, status: 400, error: "ai_safety_content_required" };
  }
  if (content.length > 8000) {
    return { ok: false, status: 413, error: "ai_safety_content_too_large" };
  }
  try {
    const stub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
    const response = await stub.fetch("https://do/evaluate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: {
          tool,
          args: { message_content: content, message_length: content.length },
          context: { objective },
        },
        identity,
      }),
    });
    const result = await response.json<any>().catch(() => ({}));
    if (!response.ok) return { ok: false, status: 503, error: "ai_safety_evaluation_failed" };
    if (result.status !== "allowed") {
      return {
        ok: false,
        status: 403,
        error: result.status === "pending_approval"
          ? "ai_safety_requires_human_approval"
          : "ai_safety_denied",
        policy: result.policy,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 503, error: "ai_safety_unavailable" };
  }
}

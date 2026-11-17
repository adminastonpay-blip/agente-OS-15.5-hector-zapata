import type { Env, Identity } from "../types";

export type AiSafetyResult =
  | { ok: true }
  | { ok: false; status: number; error: string; policy?: unknown };

/**
 * Mandatory preflight for model calls that consume user- or workflow-supplied text.
 * Missing identity/binding, transport errors, and non-allow decisions fail closed.
 */
export async function evaluateAiSafety(
  env: Pick<Env, "SAFETY">,
  identity: Identity | undefined,
  tool: string,
  content: string,
  objective: string
): Promise<AiSafetyResult> {
  if (!identity || typeof identity.actor !== "string" || !identity.actor ||
      typeof identity.tenant !== "string" || !identity.tenant ||
      !Array.isArray(identity.roles) ||
      !["public", "internal", "confidential", "secret"].includes(identity.clearance)) {
    return { ok: false, status: 503, error: "ai_safety_verified_identity_unavailable" };
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
        status: result.status === "pending_approval" ? 403 : 403,
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

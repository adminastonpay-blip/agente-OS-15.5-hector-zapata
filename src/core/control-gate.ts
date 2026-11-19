import type { Env, Identity } from "../types";
import type { MissionTokenPayload } from "./mission-token";
import { RateLimiter } from "./rate-limiter";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type InferenceScope = "chat" | "embeddings" | "tts" | "recovery_diagnosis";

const issuedPermits = new WeakMap<object, { action: InferenceScope; payload: string; model: string }>();

declare const permitBrand: unique symbol;
export interface InferencePermit {
  readonly [permitBrand]: true;
}

export type GateResult =
  | { ok: true; permit: InferencePermit }
  | { ok: false; status: 403 | 429 | 503; reason: string; policy?: unknown };

/**
 * Accepts only identities produced by the existing authentication boundary.
 * Caller-supplied tenant/user fields are never trusted here.
 */
export class ControlGate {
  constructor(private readonly env: Env) {}


  /**
   * Atomically claims a verified Recovery token before any policy evaluation
   * or inference. The tenant selects the DO partition; the signed jti is the key.
   */
  async consumeMissionToken(payload: MissionTokenPayload): Promise<
    { ok: true } | { ok: false; status: 403 | 503; reason: string }
  > {
    if (payload.action !== "recovery_diagnosis" || !payload.tenantId || !payload.jti) {
      return { ok: false, status: 403, reason: "mission_token_scope_invalid" };
    }
    const namespace = this.env.REPLAY_GUARD;
    if (!namespace) {
      return { ok: false, status: 503, reason: "mission_replay_guard_unavailable" };
    }
    try {
      const stub = namespace.get(namespace.idFromName("recovery-replay:" + payload.tenantId));
      const response = await stub.fetch("https://replay.internal/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jti: payload.jti, exp: payload.exp }),
      });
      if (response.status === 409) {
        return { ok: false, status: 403, reason: "mission_token_replay" };
      }
      if (!response.ok) {
        return { ok: false, status: 503, reason: "mission_replay_guard_unavailable" };
      }
      const result = await response.json<{ fresh?: boolean }>().catch((): { fresh?: boolean } => ({}));
      return result.fresh === true
        ? { ok: true }
        : { ok: false, status: 403, reason: "mission_token_replay" };
    } catch {
      return { ok: false, status: 503, reason: "mission_replay_guard_unavailable" };
    }
  }


  async authorizeAction(
    payload: MissionTokenPayload,
    actionContent: string
  ): Promise<GateResult> {
    if (payload.action !== "recovery_diagnosis" ||
        !payload.tenantId?.trim() || !payload.sub?.trim() ||
        typeof actionContent !== "string" || !actionContent.trim() ||
        actionContent.length > 16_000) {
      return { ok: false, status: 403, reason: "invalid_recovery_action" };
    }
    if (!this.env.AI || !this.env.SAFETY) {
      return { ok: false, status: 503, reason: "control_gate_binding_unavailable" };
    }

    const identity: Identity = {
      actor: payload.sub,
      method: "access",
      tenant: payload.tenantId,
      roles: ["recovery_diagnosis"],
      clearance: "confidential",
    };
    const contentHash = await this.sha256(actionContent);
    try {
      const safetyStub = this.env.SAFETY.get(
        this.env.SAFETY.idFromName("aston-recovery-safety:" + payload.tenantId)
      );
      const evaluation = await safetyStub.fetch("https://safety.internal/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: {
            tool: "recovery_diagnosis",
            args: { mission_id: payload.missionId, content_sha256: contentHash },
            context: { objective: "authorize recovery diagnosis", mission_id: payload.missionId },
          },
          identity,
        }),
      });
      const decision = await evaluation.json<{ status?: string; policy?: unknown }>()
        .catch((): { status?: string; policy?: unknown } => ({}));
      if (!evaluation.ok || decision.status !== "allowed") {
        return {
          ok: false,
          status: evaluation.ok ? 403 : 503,
          reason: decision.status === "pending_approval"
            ? "human_approval_required"
            : decision.status === "denied"
              ? "safety_policy_denied"
              : "safety_evaluation_failed",
          policy: decision.policy,
        };
      }

      const rate = await new RateLimiter(this.env).check(payload.tenantId, "recovery_diagnosis", 5, 60_000);
      if (!rate.allowed) {
        return {
          ok: false,
          status: rate.unavailable ? 503 : 429,
          reason: rate.unavailable ? "rate_limiter_unavailable" : "rate_limit_exceeded",
        };
      }
      const model = this.env.CHAT_MODEL;
      if (!model || !model.startsWith("@cf/")) {
        return { ok: false, status: 503, reason: "approved_recovery_model_not_configured" };
      }
      const permit = Object.freeze({});
      issuedPermits.set(permit, { action: "recovery_diagnosis", payload: actionContent, model });
      return { ok: true, permit: permit as unknown as InferencePermit };
    } catch {
      return { ok: false, status: 503, reason: "control_gate_unavailable" };
    }
  }

  /**
   * Issues a one-use capability for non-chat model operations.
   * The identity must come from resolveIdentity; raw tenant strings are never accepted.
   */
  async authorizeInference(
    identity: Identity,
    action: "embeddings" | "tts",
    payload: Record<string, unknown>,
    model: string
  ): Promise<GateResult> {
    if (
      !identity ||
      identity.method === "public" ||
      !identity.actor?.trim() ||
      !identity.tenant?.trim() ||
      !Array.isArray(identity.roles) ||
      !identity.clearance ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      !model.startsWith("@cf/")
    ) {
      return { ok: false, status: 403, reason: "verified_inference_identity_required" };
    }
    const safety = this.env.SAFETY;
    if (!this.env.AI || !safety) {
      return { ok: false, status: 503, reason: "control_gate_binding_unavailable" };
    }
    const serialized = JSON.stringify(payload);
    if (!serialized || serialized.length > 32_000) {
      return { ok: false, status: 403, reason: "inference_payload_too_large" };
    }
    try {
      const safetyStub = safety.get(safety.idFromName("aston-model-safety:" + identity.tenant));
      const evaluation = await safetyStub.fetch("https://safety.internal/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: {
            tool: action === "embeddings" ? "model_embeddings" : "model_tts",
            args: {
              model,
              payload: serialized.slice(0, 8_000),
              payload_sha256: await this.sha256(serialized),
            },
            context: { objective: action === "embeddings" ? "authorize tenant-scoped embeddings" : "authorize text-to-speech" },
          },
          identity,
        }),
      });
      const decision = await evaluation.json<{ status?: string; policy?: unknown }>()
        .catch((): { status?: string; policy?: unknown } => ({}));
      if (!evaluation.ok || decision.status !== "allowed") {
        return {
          ok: false,
          status: evaluation.ok ? 403 : 503,
          reason: decision.status === "pending_approval" ? "human_approval_required"
            : decision.status === "denied" ? "safety_policy_denied" : "safety_evaluation_failed",
          policy: decision.policy,
        };
      }
      const rate = await new RateLimiter(this.env).check(identity.tenant, action);
      if (!rate.allowed) {
        return { ok: false, status: rate.unavailable ? 503 : 429,
          reason: rate.unavailable ? "rate_limiter_unavailable" : "rate_limit_exceeded" };
      }
      const permit = Object.freeze({});
      issuedPermits.set(permit, { action, payload: serialized, model });
      return { ok: true, permit: permit as unknown as InferencePermit };
    } catch {
      return { ok: false, status: 503, reason: "control_gate_unavailable" };
    }
  }

  async authorizeChat(identity: Identity, messages: ChatMessage[]): Promise<GateResult> {
    if (
      !identity ||
      identity.method === "public" ||
      !identity.actor?.trim() ||
      !identity.tenant?.trim() ||
      !Array.isArray(identity.roles) ||
      !identity.clearance
    ) {
      return { ok: false, status: 403, reason: "verified_identity_required" };
    }

    const safetyNamespace = this.env.SAFETY;
    if (!this.env.AI || !safetyNamespace) {
      return { ok: false, status: 503, reason: "control_gate_binding_unavailable" };
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return { ok: false, status: 403, reason: "invalid_inference_payload" };
    }

    const payload = JSON.stringify(messages);
    if (payload.length > 32_000) {
      return { ok: false, status: 403, reason: "inference_payload_too_large" };
    }

    try {
      const safetyStub = safetyNamespace.get(
        safetyNamespace.idFromName("aston-chat-safety")
      );
      const userMessage = [...messages].reverse().find((item) => item.role === "user");
      const evaluation = await safetyStub.fetch("https://safety.internal/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: {
            tool: "chat_completion",
            args: {
              message: userMessage?.content ?? "",
              payload_sha256: await this.sha256(payload),
            },
            context: { objective: "authorize chat model inference" },
          },
          identity,
        }),
      });

      const decision = await evaluation
        .json<{ status?: string; policy?: unknown }>()
        .catch((): { status?: string; policy?: unknown } => ({}));
      if (!evaluation.ok || decision.status !== "allowed") {
        return {
          ok: false,
          status: evaluation.ok ? 403 : 503,
          reason: decision.status === "pending_approval"
            ? "human_approval_required"
            : decision.status === "denied"
              ? "safety_policy_denied"
              : "safety_evaluation_failed",
          policy: decision.policy,
        };
      }

      const rate = await new RateLimiter(this.env).check(identity.tenant, "chat");
      if (!rate.allowed) {
        return {
          ok: false,
          status: rate.unavailable ? 503 : 429,
          reason: rate.unavailable ? "rate_limiter_unavailable" : "rate_limit_exceeded",
        };
      }

      const model = this.env.CHAT_MODEL;
      if (!model || !model.startsWith("@cf/")) {
        return { ok: false, status: 503, reason: "approved_chat_model_not_configured" };
      }

      const permit = Object.freeze({});
      issuedPermits.set(permit, { action: "chat", payload, model });
      return { ok: true, permit: permit as unknown as InferencePermit };
    } catch {
      return { ok: false, status: 503, reason: "control_gate_unavailable" };
    }
  }

  private async sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

/** Internal capability consumption: one permit, one exact payload, one inference. */
export function consumeInferencePermit(
  permit: InferencePermit,
  action: InferenceScope,
  payload: string,
  model: string
): boolean {
  if (!permit || typeof permit !== "object") return false;
  const issued = issuedPermits.get(permit as object);
  if (!issued || issued.action !== action || issued.payload !== payload || issued.model !== model) {
    return false;
  }
  issuedPermits.delete(permit as object);
  return true;
}

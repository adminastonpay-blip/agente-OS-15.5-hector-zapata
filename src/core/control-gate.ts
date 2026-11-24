import type { Env, Identity } from "../types";
import type { MissionTokenPayload } from "./mission-token";
import { RateLimiter } from "./rate-limiter";
import { signInternalAssertion, MAX_INTERNAL_ASSERTION_TTL_MS } from "./attestation";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type InferenceScope = "chat" | "embeddings" | "tts" | "extraction" | "recovery_diagnosis";

const INFERENCE_PERMIT_TTL_MS = 60_000;
const issuedPermits = new WeakMap<
  object,
  { action: InferenceScope; payload: string; model: string; expiresAt: number }
>();

declare const permitBrand: unique symbol;
export interface InferencePermit {
  readonly [permitBrand]: true;
}

export type GateResult =
  | { ok: true; permit: InferencePermit }
  | { ok: false; status: 403 | 429 | 503; reason: string; policy?: unknown };

type AssertionCapableEnv = Env & {
  INTERNAL_ASSERTION_SECRET?: string;
  INTERNAL_ASSERTION_KEY_ID?: string;
};

/**
 * Consumes a one-use InferencePermit for a given scope and payload/model.
 * Returns false and evicts expired or mismatched permits (fail-closed).
 */
export function consumeInferencePermit(
  permit: InferencePermit | undefined | null,
  expectedAction: InferenceScope,
  expectedPayload?: string,
  expectedModel?: string,
  nowMs = Date.now()
): boolean {
  if (!permit || typeof permit !== "object") return false;
  const record = issuedPermits.get(permit as unknown as object);
  issuedPermits.delete(permit as unknown as object);
  if (!record) return false;
  if (record.action !== expectedAction) return false;
  if (record.expiresAt <= nowMs) return false;
  if (typeof expectedPayload === "string" && record.payload !== expectedPayload) return false;
  if (typeof expectedModel === "string" && record.model !== expectedModel) return false;
  return true;
}

/**
 * Accepts only identities produced by the existing authentication boundary.
 * Caller-supplied tenant/user fields are never trusted here.
 */
export class ControlGate {
  constructor(private readonly env: AssertionCapableEnv) {}

  private async sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  private async createInternalAssertionHeaders(
    aud: string,
    subjectTenant: string,
    subjectActor: string
  ): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; reason: string }> {
    const secret = this.env.INTERNAL_ASSERTION_SECRET;
    const keyId = this.env.INTERNAL_ASSERTION_KEY_ID;
    if (!secret && !keyId) {
      return { ok: true, headers: {} };
    }
    if (!secret || !keyId) {
      return { ok: false, reason: "internal_assertion_config_incomplete" };
    }
    try {
      const token = await signInternalAssertion(
        {
          iss: "control-gate",
          aud,
          sub_tenant: subjectTenant,
          sub_actor: subjectActor,
          jti: crypto.randomUUID(),
          ttlMs: MAX_INTERNAL_ASSERTION_TTL_MS,
        },
        secret,
        keyId
      );
      return { ok: true, headers: { "x-aston-internal-assertion": token } };
    } catch {
      return { ok: false, reason: "internal_assertion_sign_failed" };
    }
  }

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
    const assertion = await this.createInternalAssertionHeaders(
      "replay-guard",
      payload.tenantId,
      payload.sub || "recovery"
    );
    if (!assertion.ok) {
      return { ok: false, status: 503, reason: assertion.reason };
    }
    try {
      const stub = namespace.get(namespace.idFromName("recovery-replay:" + payload.tenantId));
      const response = await stub.fetch("https://replay.internal/consume", {
        method: "POST",
        headers: { "content-type": "application/json", ...assertion.headers },
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
    if (
      payload.action !== "recovery_diagnosis" ||
      !payload.tenantId?.trim() ||
      !payload.sub?.trim() ||
      typeof actionContent !== "string" ||
      !actionContent.trim() ||
      actionContent.length > 16_000
    ) {
      return { ok: false, status: 403, reason: "invalid_recovery_action" };
    }
    if (!this.env.AI || !this.env.SAFETY) {
      return { ok: false, status: 503, reason: "control_gate_binding_unavailable" };
    }

    const assertion = await this.createInternalAssertionHeaders(
      "safety-interlock",
      payload.tenantId,
      payload.sub
    );
    if (!assertion.ok) {
      return { ok: false, status: 503, reason: assertion.reason };
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
        headers: { "content-type": "application/json", ...assertion.headers },
        body: JSON.stringify({
          action: {
            tool: "recovery_diagnosis",
            args: { mission_id: payload.missionId, content_sha256: contentHash },
            context: { objective: "authorize recovery diagnosis", mission_id: payload.missionId },
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
          reason:
            decision.status === "pending_approval"
              ? "human_approval_required"
              : decision.status === "denied"
                ? "safety_policy_denied"
                : "safety_evaluation_failed",
          policy: decision.policy,
        };
      }

      const rate = await new RateLimiter(this.env).check(
        payload.tenantId,
        "recovery_diagnosis",
        5,
        60_000
      );
      if (!rate.allowed) {
        return {
          ok: false,
          status: rate.unavailable ? 503 : 429,
          reason: rate.unavailable ? "rate_limiter_unavailable" : "rate_limit_exceeded",


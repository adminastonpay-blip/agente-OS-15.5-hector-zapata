import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env, MissionParams } from "../types";
import { maskForAgent } from "../pii";
import { probeRecoveryOrigin } from "../security/recovery-guard";
import { MissionTokenVerifier } from "../core/mission-token";
import { ControlGate } from "../core/control-gate";
import { ModelRunner } from "../core/model-runner";

export class RecoveryWorkflow extends WorkflowEntrypoint<Env, MissionParams> {
  async run(event: WorkflowEvent<MissionParams>, step: WorkflowStep) {
    const m = event.payload;
    if (!m || typeof m.id !== "string" || !m.id ||
        typeof m.origin !== "string" || !Number.isSafeInteger(m.error_code) ||
        typeof m.mission_token !== "string" || !m.mission_token) {
      throw new Error("invalid_recovery_mission_payload");
    }

    // Verification and durable jti claim happen before policy evaluation or inference.
    // The durable step stores its result so Workflow retries do not re-consume a token
    // after this step has completed.
    const missionClaims = await (step.do as any)("verify-and-consume-mission-token", {
      retries: { limit: 0 },
      timeout: "15 seconds",
    }, async () => {
      if (!this.env.MISSION_TOKEN_PUBLIC_KEY) throw new Error("mission_token_public_key_missing");
      const verifier = await MissionTokenVerifier.fromBase64UrlPublicKey(
        this.env.MISSION_TOKEN_PUBLIC_KEY
      );
      const claims = await verifier.verify(m.mission_token);
      if (claims.missionId !== m.id) throw new Error("mission_token_mission_mismatch");
      const claimed = await new ControlGate(this.env).consumeMissionToken(claims);
      if (!claimed.ok) throw new Error(claimed.reason);
      return claims;
    });

    const diag = await (step.do as any)("edge-diagnose", {
      retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
      timeout: "15 seconds",
    }, async () => probeRecoveryOrigin(
      m.origin,
      this.env.RECOVERY_ALLOWED_ORIGINS
    )) as {
      reachable: boolean;
      status: number;
      latency_ms: number;
      blocked?: string;
    };

    const hypothesis = await (step.do as any)("reason-hypothesis", {
      retries: { limit: 0 },
      timeout: "30 seconds",
    }, async () => {
      if (!this.env.PII_HMAC_SECRET) throw new Error("pii_masking_secret_missing");
      if (!this.env.AI) throw new Error("ai_binding_unavailable");
      const prompt = JSON.stringify({
        task: "recovery_diagnosis",
        mission_id: m.id,
        diagnostic: diag,
        origin: m.origin,
        error_code: m.error_code,
        response_schema: { text: "string", confidence: "number", action: "none" },
      });
      const { masked } = await maskForAgent(prompt, "internal", this.env.PII_HMAC_SECRET);
      const gate = await new ControlGate(this.env).authorizeAction(missionClaims, masked);
      if (!gate.ok) throw new Error(gate.reason);
      const result = await new ModelRunner(this.env).runInference(
        gate.permit,
        "recovery_diagnosis",
        masked,
        { maxTokens: 512, temperature: 0.1 }
      );
      const output = result.response;
      try {
        return JSON.parse(output);
      } catch {
        return { text: output, confidence: 0.5, action: "none" };
      }
    });

    let approval: { approved: boolean; operator: string };
    try {
      const received = await (step.waitForEvent as any)(
        "await-operator-approval",
        { type: "recovery.approved", timeout: "24 hours" }
      ) as { payload: { approved: boolean; operator: string } };
      approval = received.payload;
    } catch {
      // Fail closed: timeout must never authorize remediation.
      approval = { approved: false, operator: "timeout-escalation" };
    }

    // Approval remains a manual-action record, never an execution grant.
    const remediationStatus = approval.approved
      ? "manual_action_required_automation_disabled"
      : "not_approved";

    await (step.do as any)("persist-journal", {
      retries: { limit: 1, delay: "1 second" },
    }, async () => {
      if (!this.env.JOURNAL) throw new Error("R2 JOURNAL binding required");
      const { mission_token: _discardedToken, created_by: _untrustedCreator, ...safeMission } = m;
      await this.env.JOURNAL.put(
        `workflows/${event.instanceId}/result.json`,
        JSON.stringify({
          mission: safeMission,
          authorized_subject: missionClaims.sub,
          tenant: missionClaims.tenantId,
          diag,
          hypothesis,
          approval,
          remediation: { status: remediationStatus },
          ts: Date.now(),
        })
      );
      return { persisted: true };
    });

    return { remediation_status: remediationStatus, journaled: true };
  }
}

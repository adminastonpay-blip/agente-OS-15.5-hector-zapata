import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env, MissionParams } from "../types";
import { maskForAgent, restoreFromVault } from "../pii";
import { isAllowedRecoveryOrigin } from "../security/recovery-guard";

export class RecoveryWorkflow extends WorkflowEntrypoint<Env, MissionParams> {
  async run(event: WorkflowEvent<MissionParams>, step: WorkflowStep) {
    const m = event.payload;
    const originAllowed = isAllowedRecoveryOrigin(m.origin, this.env.RECOVERY_ALLOWED_ORIGINS);

    const diag = await (step.do as any)("edge-diagnose", {
      retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
      timeout: "30 seconds",
    }, async () => {
      const t0 = Date.now();
      if (!originAllowed) {
        return {
          reachable: false,
          status: 0,
          latency_ms: 0,
          blocked: "origin_not_allowlisted",
        };
      }
      try {
        const r = await fetch(m.origin, { method: "HEAD", signal: AbortSignal.timeout(3000) });
        return { reachable: r.ok, status: r.status, latency_ms: Date.now() - t0 };
      } catch {
        return { reachable: false, status: 0, latency_ms: Date.now() - t0 };
      }
    }) as {
      reachable: boolean;
      status: number;
      latency_ms: number;
      blocked?: string;
    };

    const hypothesis = await (step.do as any)("reason-hypothesis", {
      retries: { limit: 2, delay: "10 seconds" },
    }, async () => {
      const prompt = `Diag ${JSON.stringify(diag)} origen ${m.origin} err ${m.error_code}.
JSON: {"text":"","confidence":0,"action":""}`;
      const { masked, vault } = await maskForAgent(prompt, "internal", this.env.PII_HMAC_SECRET!);
      const res = await this.env.AI!.run(this.env.CHAT_MODEL as any,
        { messages: [{ role: "user", content: masked }] } as any,
        { gateway: { id: this.env.AI_GATEWAY_ID } } as any) as any;
      const real = restoreFromVault(String(res?.response ?? ""), vault);
      try {
        return JSON.parse(real);
      } catch {
        return { text: real, confidence: 0.5, action: "none" };
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

    // Automated Cloudflare Load Balancer mutations are intentionally disabled.
    // Approval is recorded as a request for manual action; it is not an execution grant.
    const remediationStatus = approval.approved
      ? "manual_action_required_automation_disabled"
      : "not_approved";

    await (step.do as any)("persist-journal", {
      retries: { limit: 1, delay: "1 second" },
    }, async () => {
      if (!this.env.JOURNAL) throw new Error("R2 JOURNAL binding required");
      await this.env.JOURNAL.put(
        `workflows/${event.instanceId}/result.json`,
        JSON.stringify({
          mission: m,
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

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import type { Env, MissionParams } from "../types";
import { maskForAgent, restoreFromVault } from "../pii";

export class RecoveryWorkflow extends WorkflowEntrypoint<Env, MissionParams> {
  async run(event: WorkflowEvent<MissionParams>, step: WorkflowStep) {
    const m = event.payload;

    const diag = await step.do("edge-diagnose", {
      retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
      timeout: "30 seconds",
    }, async () => {
      const t0 = Date.now();
      try {
        const r = await fetch(m.origin, { method: "HEAD", signal: AbortSignal.timeout(3000) });
        return { reachable: r.ok, status: r.status, latency_ms: Date.now() - t0 };
      } catch { return { reachable: false, status: 0, latency_ms: Date.now() - t0 }; }
    });

    const hypothesis = await step.do("reason-hypothesis", {
      retries: { limit: 2, delay: "10 seconds" },
    }, async () => {
      const prompt = `Diag ${JSON.stringify(diag)} origen ${m.origin} err ${m.error_code}.
JSON: {"text":"","confidence":0,"action":""}`;
      const { masked, vault } = await maskForAgent(prompt, "internal", this.env.PII_HMAC_SECRET!);
      const res = await this.env.AI.run(this.env.CHAT_MODEL as any,
        { messages: [{ role: "user", content: masked }] } as any,
        { gateway: { id: this.env.AI_GATEWAY_ID } } as any) as any;
      const real = restoreFromVault(res.response, vault);
      try { return JSON.parse(real); } catch { return { text: real, confidence: 0.5, action: "none" }; }
    });

    // Espera humana durable (sin consumir concurrencia)
    let approval: { approved: boolean; operator: string };
    try {
      approval = await step.waitForEvent<{ approved: boolean; operator: string }>(
        "await-operator-approval",
        { type: "recovery.approved", timeout: "24 hours" }
      );
    } catch {
      approval = { approved: m.severity === "critical", operator: "timeout-escalation" };
    }

    if (approval.approved) {
      await step.do("apply-remediation", {
        retries: { limit: 3, delay: "15 seconds" },
      }, async () => {
        if (this.env.CF_API_TOKEN) {
          const r = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT_ID}/load_balancers/pools/${m.pool_id}`,
            { method: "PATCH",
              headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}`, "Content-Type": "application/json" },
              body: JSON.stringify({ enabled: false }) }
          );
          return { status: r.ok ? "ok" : "failed", http: r.status };
        }
        return { status: "no_token" };
      });

      await step.sleep("stabilization-window", "5 minutes");

      await step.do("verify-restoration", async () => {
        try {
          const r = await fetch(m.origin, { method: "HEAD", signal: AbortSignal.timeout(3000) });
          return { ok: r.ok, status: r.status };
        } catch { return { ok: false, status: 0 }; }
      });
    }

    await step.do("persist-journal", {
      retries: { limit: 1 },
    }, async () => {
      await this.env.JOURNAL.put(
        `workflows/${event.instanceId}/result.json`,
        JSON.stringify({ mission: m, diag, hypothesis, approval, ts: Date.now() })
      );
      return { persisted: true };
    });
  }
}

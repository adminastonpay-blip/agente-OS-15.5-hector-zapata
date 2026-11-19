import type { Env, Identity } from "../types";
import { createObject } from "../ontology";
import { maskForAgent, restoreFromVault } from "../pii";
import { embed, chat } from "../lib/ai";

export class AgentNode {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname !== "/execute" || req.method !== "POST")
      return new Response("not found", { status: 404 });

    const { role, goal, context, identity, tools } = await req.json<any>();
    if (!identity || identity.method === "public" || !identity.actor?.trim() || !identity.tenant?.trim() || !Array.isArray(identity.roles) || !identity.clearance) {
      return Response.json({ error: "verified_inference_identity_required" }, { status: 403 });
    }
    let attempts = 0,
      lastErr = "";
    while (attempts < 3) {
      attempts++;
      try {
        const planGate = await this.safetyCheck(
          identity,
          { tool: "agent_model_plan", args: { goal_length: String(goal || "").length } },
          { goal, role }
        );
        if (planGate.status !== "allowed") {
          return Response.json({
            result: "Model planning blocked by SafetyInterlock",
            attempts,
            status: planGate.status,
            policy: planGate.policy,
          }, { status: planGate.status === "pending_approval" ? 202 : 503 });
        }
        const calls = await this.planTools(identity, role, goal, context, tools);
        const obs: string[] = [];
        const blocked: any[] = [];

        for (const c of calls) {
          const gate = await this.safetyCheck(identity, c, { goal, role });
          if (gate.status === "denied") {
            obs.push(`[${c.tool}] DENIED: ${(gate.policy?.reasons ?? []).join("; ")}`);
            blocked.push({ tool: c.tool, status: "denied", policy: gate.policy });
            continue;
          }
          if (gate.status === "pending_approval") {
            obs.push(`[${c.tool}] PENDING APPROVAL (id=${gate.approval_id})`);
            blocked.push({
              tool: c.tool,
              status: "pending_approval",
              approval_id: gate.approval_id,
              policy: gate.policy,
            });
            continue;
          }
          if (gate.status !== "allowed") {
            obs.push(`[${c.tool}] DENIED: invalid SafetyInterlock decision status`);
            blocked.push({ tool: c.tool, status: "denied", policy: { reasons: ["invalid SafetyInterlock decision status"] } });
            continue;
          }
          try {
            obs.push(`[${c.tool}] ${await this.runTool(identity, c)}`);
          } catch (e) {
            obs.push(`[${c.tool}] ERROR: ${(e as Error).message}`);
          }
        }

        const synthGate = await this.safetyCheck(
          identity,
          { tool: "agent_model_synthesis", args: { goal_length: String(goal || "").length } },
          { goal, role }
        );
        if (synthGate.status !== "allowed") {
          return Response.json({
            result: "Model synthesis blocked by SafetyInterlock",
            attempts,
            status: synthGate.status,
            policy: synthGate.policy,
            blocked,
          }, { status: synthGate.status === "pending_approval" ? 202 : 503 });
        }
        const answer = await this.synthesize(identity, role, goal, context, obs);
        const status = blocked.some((b) => b.status === "pending_approval")
          ? "partial_pending_approval"
          : blocked.some((b) => b.status === "denied")
            ? "partial_denied"
            : "done";

        return Response.json({
          result: answer,
          attempts,
          status,
          blocked: blocked.length ? blocked : undefined,
        });
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }
    return Response.json({ result: `failed: ${lastErr}`, attempts, status: "failed" });
  }

  private async safetyCheck(
    identity: any,
    call: { tool: string; args: Record<string, unknown> },
    ctx: { goal: string; role: string }
  ): Promise<{
    status: "allowed" | "denied" | "pending_approval";
    approval_id?: string;
    policy?: { reasons?: string[] };
  }> {
    const denied = (reason: string) => ({
      status: "denied" as const,
      policy: { reasons: [reason] },
    });
    if (!this.env.SAFETY) return denied("SAFETY DO missing — fail-closed");

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const stub = this.env.SAFETY.get(this.env.SAFETY.idFromName(identity.tenant));
      const request = stub.fetch("https://do/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          action: {
            tool: call.tool,
            args: call.args ?? {},
            context: { objective: ctx.goal, role: ctx.role },
          },
          identity,
        }),
      }).then(async (res) => {
        if (!res.ok) return denied("SafetyInterlock request failed — fail-closed");
        const payload = await res.json() as any;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return denied("SafetyInterlock response malformed — fail-closed");
        }
        if (payload.contract_version !== "1") {
          return denied("SafetyInterlock contract version unsupported — fail-closed");
        }
        if (!["allowed", "denied", "pending_approval"].includes(payload.status)) {
          return denied("SafetyInterlock decision status invalid — fail-closed");
        }
        if (payload.status === "pending_approval" &&
            (typeof payload.approval_id !== "string" || !payload.approval_id)) {
          return denied("SafetyInterlock approval reference missing — fail-closed");
        }
        return payload as {
          status: "allowed" | "denied" | "pending_approval";
          approval_id?: string;
          policy?: { reasons?: string[] };
        };
      });
      const deadline = new Promise<ReturnType<typeof denied>>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(denied("SafetyInterlock evaluation timed out — fail-closed"));
        }, 2000);
      });
      return await Promise.race([request, deadline]);
    } catch {
      return denied("SafetyInterlock unavailable — fail-closed");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async planTools(identity: Identity, role: string, goal: string, context: string, tools: string[]) {
    const r = await chat(this.env, identity, [
      {
        role: "system",
        content: `Agente "${role}". Tools: ${(tools || ["reason"]).join(",")}. JSON: {"tools":[{"tool":"n","args":{}}]}`,
      },
      { role: "user", content: `Objetivo: ${goal}\nContexto:\n${context}` },
    ]);
    try {
      return JSON.parse(r.response).tools ?? [];
    } catch {
      return [{ tool: "reason", args: { prompt: goal } }];
    }
  }

  private async runTool(identity: Identity, c: any): Promise<string> {
    if (c.tool === "search") {
      if (!this.env.VECTORIZE) return "search unavailable (VECTORIZE not bound)";
      const [qvec] = await embed(this.env, identity, [c.args?.query || ""]);
      const m = await this.env.VECTORIZE.query(qvec, { topK: 3, returnMetadata: "all" } as any);
      return (m.matches ?? [])
        .map((x: any) => `[${x.metadata?.source}] ${x.metadata?.chunk}`)
        .join("\n");
    }
    if (c.tool === "graph_query") {
      if (!this.env.GRAPH) return "graph unavailable";
      const stub = this.env.GRAPH.get(this.env.GRAPH.idFromName(identity.tenant));
      if (c.args?.type === "neighbors")
        return JSON.stringify(
          await (await stub.fetch(`https://do/neighbors?id=${c.args.id}`)).json()
        );
      return JSON.stringify(
        await (await stub.fetch(`https://do/path?from=${c.args?.id}&to=${c.args?.to}`)).json()
      );
    }
    if (c.tool === "write") {
      if (!identity.roles?.includes("executor")) throw new Error("role not allowed to write");
      if (!this.env.DB) throw new Error("DB required for write");
      if (c.args?.op === "create_object")
        return `created ${await createObject(this.env, identity, {
          type_id: c.args.type_id,
          properties: c.args.properties,
        })}`;
      throw new Error("unsupported op");
    }
    const r = await chat(this.env, identity, [
      { role: "system", content: "Razona brevemente. No inventes." },
      { role: "user", content: c.args?.prompt || "" },
    ]);
    return r.response;
  }

  private async synthesize(
    identity: Identity,
    role: string,
    goal: string,
    context: string,
    obs: string[]
  ) {
    const r = await chat(this.env, identity, [
      { role: "system", content: `Agente "${role}". Sintetiza veraz y conciso.` },
      {
        role: "user",
        content: `Objetivo: ${goal}\nContexto:\n${context}\nObservaciones:\n${obs.join("\n")}`,
      },
    ]);
    const secret = this.env.PII_HMAC_SECRET || "aston-edge-default-pii";
    const { masked, vault } = await maskForAgent(
      r.response,
      identity.clearance || "public",
      secret
    );
    return restoreFromVault(masked, vault);
  }
}

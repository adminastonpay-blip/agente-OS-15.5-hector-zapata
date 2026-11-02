import type { Env } from "../types";

const ALLOWED_TOOLS: Record<string, string[]> = {
  investigator: ["search", "graph_query", "reason"],
  analyst: ["search", "graph_query", "reason"],
  verifier: ["search", "reason"],
  executor: ["search", "graph_query", "reason", "write"],
};

export class Supervisor {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname !== "/plan" || req.method !== "POST")
      return new Response("not found", { status: 404 });

    const { objective, identity } = await req.json<any>();
    const planRes = await this.env.AI.run(this.env.CHAT_MODEL as any, {
      messages: [
        { role: "system", content: `Planificador. JSON SOLO: {"tasks":[{"role":"investigator|analyst|verifier|executor","goal":"...","depends_on":[idx]}]}. Máx 6.` },
        { role: "user", content: `Objetivo: ${objective}\nTenant: ${identity.tenant}` },
      ],
    } as any, { gateway: { id: this.env.AI_GATEWAY_ID } } as any) as any;

    let plan: { tasks: any[] };
    try { plan = JSON.parse(planRes.response); }
    catch { return Response.json({ error: "planning failed", raw: planRes.response }, { status: 500 }); }

    const planId = `plan_${crypto.randomUUID()}`;
    await this.env.DB.prepare(
      `INSERT INTO swarm_tasks (id, parent_id, tenant, role, goal, status, created_at, updated_at)
       VALUES (?, ?, ?, 'supervisor', ?, 'pending', ?, ?)`
    ).bind(planId, null, identity.tenant, objective, Date.now(), Date.now()).run();

    const results: any[] = [];
    const done = new Set<number>();

    for (let i = 0; i < plan.tasks.length; i++) {
      const t = plan.tasks[i];
      const deps = t.depends_on ?? [];
      while (!deps.every((d: number) => done.has(d))) await new Promise((r) => setTimeout(r, 200));

      const agentId = `ag_${crypto.randomUUID()}`;
      const stub = this.env.AGENT.get(this.env.AGENT.idFromName(`${identity.tenant}:${agentId}`));
      const prior = results.map((r, idx) => `[${idx}] ${r.role}: ${r.result}`).join("\n");

      const r = await stub.fetch("https://do/execute", {
        method: "POST",
        body: JSON.stringify({ role: t.role, goal: t.goal, context: prior, identity, tools: ALLOWED_TOOLS[t.role] }),
      });
      const out = await r.json<any>();
      results.push({ role: t.role, goal: t.goal, result: out.result, attempts: out.attempts });
      done.add(i);

      await this.env.DB.prepare(
        `INSERT INTO swarm_tasks (id, parent_id, tenant, role, goal, status, attempts, result, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(`task_${crypto.randomUUID()}`, planId, identity.tenant, t.role, t.goal,
        out.status, out.attempts, out.result, Date.now(), Date.now()).run();
    }
    return Response.json({ planId, objective, results });
  }
}

import type { Env, Mission } from "../types";
import { maskForAgent, restoreFromVault } from "../pii";

export class MissionBrain {
  private sql: SqlStorage;
  constructor(private state: DurableObjectState, private env: Env) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, phase TEXT,
      action TEXT, status TEXT, detail TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS hypothesis (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, text TEXT,
      confidence REAL, status TEXT)`);
  }

  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/run" && req.method === "POST") {
      const mission = await req.json<Mission>();
      return Response.json(await this.execute(mission));
    }
    if (u.pathname === "/journal") {
      return Response.json({
        journal: this.sql.exec("SELECT * FROM journal ORDER BY id ASC").toArray(),
        hypothesis: this.sql.exec("SELECT * FROM hypothesis ORDER BY id ASC").toArray(),
      });
    }
    return new Response("not found", { status: 404 });
  }

  private log(phase: string, action: string, status: string, detail?: string) {
    this.sql.exec("INSERT INTO journal (ts, phase, action, status, detail) VALUES (?, ?, ?, ?, ?)",
      Date.now(), phase, action, status, detail ?? null);
  }

  private async execute(m: Mission) {
    this.log("detect", "mission_received", "ok", `origin=${m.origin} err=${m.error_code}`);

    // 1) Diagnóstico
    const diag = await this.diagnose(m);
    this.log("diagnose", "edge_probe", diag.reachable ? "ok" : "failed", JSON.stringify(diag));

    // 2) Razonamiento con PII masking
    const prompt = `Misión recuperación. Origen: ${m.origin}. Error: ${m.error_code}. Pool: ${m.pool_id}. Diag: ${JSON.stringify(diag)}.
JSON SOLO:
{"text":"<hipótesis>","confidence":0.0-1.0,"action":"restart|drain|failover|isolate|none"}`;
    const { masked, vault } = await maskForAgent(prompt, "internal", this.env.PII_HMAC_SECRET!);
    const res = await this.env.AI.run(this.env.CHAT_MODEL as any,
      { messages: [{ role: "user", content: masked }] } as any,
      { gateway: { id: this.env.AI_GATEWAY_ID } } as any) as any;
    const real = restoreFromVault(res.response, vault);
    let hypothesis: any;
    try { hypothesis = JSON.parse(real); }
    catch { hypothesis = { text: real, confidence: 0.5, action: "none" }; }
    this.sql.exec("INSERT INTO hypothesis (ts, text, confidence, status) VALUES (?, ?, ?, 'open')",
      Date.now(), hypothesis.text, hypothesis.confidence);
    this.log("diagnose", "hypothesis_created", "ok", hypothesis.text);

    // 3) Contención
    let restored = false;
    if (!diag.reachable || diag.degraded) {
      const action = await this.containAndRestore(m, hypothesis);
      this.log("contain", action.name, action.status, action.detail);
      restored = action.status === "ok";
    }

    // 4) Verificación
    if (restored) {
      await new Promise((r) => setTimeout(r, 2000));
      const ok = await this.verify(m);
      this.log("verify", "post_restore_check", ok ? "ok" : "failed");
      restored = ok;
    }

    // 5) Persistir journal a R2
    const journal = this.sql.exec("SELECT * FROM journal").toArray();
    await this.env.JOURNAL.put(`missions/${m.id}/journal.json`,
      JSON.stringify({ mission: m, journal, hypothesis }));

    return { mission_id: m.id, restored, hypothesis: hypothesis.text };
  }

  private async diagnose(m: Mission) {
    const t0 = Date.now();
    try {
      const r = await fetch(m.origin, { method: "HEAD", signal: AbortSignal.timeout(3000) });
      return { reachable: r.ok, status: r.status, latency_ms: Date.now() - t0,
        degraded: !r.ok && r.status < 500 };
    } catch { return { reachable: false, status: 0, latency_ms: Date.now() - t0, degraded: false }; }
  }

  private async containAndRestore(m: Mission, h: any) {
    if ((h.action === "failover" || m.severity === "critical") && this.env.CF_API_TOKEN) {
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT_ID}/load_balancers/pools/${m.pool_id}`,
        { method: "PATCH",
          headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }) }
      );
      return { name: "disable_pool", status: r.ok ? "ok" : "failed", detail: `status=${r.status}` };
    }
    return { name: "no_op", status: "ok", detail: h.action };
  }

  private async verify(m: Mission) {
    try {
      const r = await fetch(m.origin, { method: "HEAD", signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch { return false; }
  }
}

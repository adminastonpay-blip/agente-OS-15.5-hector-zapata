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
    this.sql.exec(
      "INSERT INTO journal (ts, phase, action, status, detail) VALUES (?, ?, ?, ?, ?)",
      Date.now(),
      phase,
      action,
      status,
      detail ?? null
    );
  }

  private async execute(m: Mission) {
    this.log("detect", "mission_received", "ok", `origin=${m.origin} err=${m.error_code}`);

    const diag = await this.diagnose(m);
    this.log("diagnose", "edge_probe", diag.reachable ? "ok" : "failed", JSON.stringify(diag));

    const prompt = `Misión recuperación. Origen: ${m.origin}. Error: ${m.error_code}. Pool: ${m.pool_id}. Diag: ${JSON.stringify(diag)}.
JSON SOLO:
{"text":"<hipótesis>","confidence":0.0-1.0,"action":"restart|drain|failover|isolate|none"}`;
    const secret = this.env.PII_HMAC_SECRET || "aston-edge-default-pii";
    const { masked, vault } = await maskForAgent(prompt, "internal", secret);
    let res: any;
    try {
      res = await this.env.AI.run(this.env.CHAT_MODEL as any, {
        messages: [{ role: "user", content: masked }],
      } as any);
    } catch {
      res = await this.env.AI.run(this.env.CHAT_MODEL as any, {
        messages: [{ role: "user", content: masked }],
      } as any);
    }
    const textOut =
      typeof res?.response === "string"
        ? res.response
        : typeof res === "string"
          ? res
          : JSON.stringify(res);
    const real = restoreFromVault(textOut, vault);
    let hypothesis: any;
    try {
      hypothesis = JSON.parse(real.replace(/```json|```/g, "").trim());
    } catch {
      hypothesis = { text: real, confidence: 0.5, action: "none" };
    }
    this.sql.exec(
      "INSERT INTO hypothesis (ts, text, confidence, status) VALUES (?, ?, ?, 'open')",
      Date.now(),
      hypothesis.text,
      hypothesis.confidence ?? 0.5
    );
    this.log("diagnose", "hypothesis_created", "ok", hypothesis.text);

    let restored = false;
    if (!diag.reachable || diag.degraded) {
      const action = await this.containAndRestore(m, hypothesis);
      this.log("contain", action.name, action.status, action.detail);
      restored = action.status === "ok";
    }

    if (restored) {
      await new Promise((r) => setTimeout(r, 500));
      const ok = await this.verify(m);
      this.log("verify", "post_restore_check", ok ? "ok" : "failed");
      restored = ok;
    }

    const journal = this.sql.exec("SELECT * FROM journal").toArray();
    if (this.env.JOURNAL) {
      await this.env.JOURNAL.put(
        `missions/${m.id}/journal.json`,
        JSON.stringify({ mission: m, journal, hypothesis })
      ).catch(() => {});
    }

    return { mission_id: m.id, restored, hypothesis: hypothesis.text, journal_persisted: !!this.env.JOURNAL };
  }

  private async diagnose(m: Mission) {
    const t0 = Date.now();
    try {
      const r = await fetch(m.origin, { method: "HEAD", signal: AbortSignal.timeout(3000) });
      return {
        reachable: r.ok,
        status: r.status,
        latency_ms: Date.now() - t0,
        degraded: !r.ok && r.status < 500,
      };
    } catch {
      return { reachable: false, status: 0, latency_ms: Date.now() - t0, degraded: false };
    }
  }

  private async containAndRestore(m: Mission, h: any) {
    if ((h.action === "failover" || m.severity === "critical") && (this.env as any).CF_API_TOKEN) {
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${(this.env as any).CF_ACCOUNT_ID}/load_balancers/pools/${m.pool_id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${(this.env as any).CF_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ enabled: false }),
        }
      );
      return { name: "disable_pool", status: r.ok ? "ok" : "failed", detail: `status=${r.status}` };
    }
    return { name: "no_op", status: "ok", detail: h.action };
  }

  private async verify(m: Mission) {
    try {
      const r = await fetch(m.origin, { method: "HEAD", signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  }
}

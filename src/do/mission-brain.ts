import type { Env, Mission } from "../types";
import { isAllowedRecoveryOrigin } from "../security/recovery-guard";

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

    // Model-driven remediation is intentionally disabled in this legacy path.
    // A human must review the diagnosis before any infrastructure action is taken.
    const hypothesis = {
      text: "Diagnóstico automático deshabilitado; requiere revisión humana.",
      confidence: 0,
      action: "none",
    };
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
    if (!isAllowedRecoveryOrigin(m.origin, this.env.RECOVERY_ALLOWED_ORIGINS)) {
      return {
        reachable: false,
        status: 0,
        latency_ms: 0,
        degraded: false,
        blocked: "origin_not_allowlisted",
      };
    }
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

  private async containAndRestore(_m: Mission, _h: any) {
    // No automatic Cloudflare API mutations are permitted from MissionBrain.
    return {
      name: "manual_action_required",
      status: "blocked",
      detail: "Automated infrastructure mutation is disabled; operator review and an independently authorized change are required.",
    };
  }

}

import type { Env } from "../types";
import { emitLineage } from "../lineage";

export class SimulationTwin {
  private sql: SqlStorage;
  constructor(private state: DurableObjectState, private env: Env) {
    this.sql = state.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS snap (id TEXT PRIMARY KEY, type_id TEXT, properties TEXT)`
    );
    this.sql.exec(`CREATE TABLE IF NOT EXISTS deltas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, op TEXT, payload TEXT, effect TEXT)`);
    try {
      state.storage.setAlarm(Date.now() + 30 * 60 * 1000);
    } catch {
      /* alarm optional */
    }
  }

  async alarm() {
    try {
      await this.state.storage.deleteAll();
    } catch {
      /* ignore */
    }
  }

  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/init" && req.method === "POST") {
      const { objects } = await req.json<any>();
      const list = Array.isArray(objects) ? objects : [];
      for (const o of list) {
        this.sql.exec(
          "INSERT OR REPLACE INTO snap (id, type_id, properties) VALUES (?, ?, ?)",
          o.id,
          o.type_id,
          typeof o.properties === "string" ? o.properties : JSON.stringify(o.properties ?? {})
        );
      }
      return Response.json({ loaded: list.length });
    }
    if (u.pathname === "/apply" && req.method === "POST") {
      const d = await req.json<any>();
      const before = this.sql
        .exec("SELECT properties FROM snap WHERE id = ?", d.payload?.id)
        .toArray()[0];
      if (d.op === "update_object" && before) {
        const merged = {
          ...JSON.parse((before as any).properties || "{}"),
          ...(d.payload?.changes || {}),
        };
        this.sql.exec(
          "UPDATE snap SET properties = ? WHERE id = ?",
          JSON.stringify(merged),
          d.payload.id
        );
      } else if (d.op === "delete_object") {
        this.sql.exec("DELETE FROM snap WHERE id = ?", d.payload?.id);
      }
      this.sql.exec(
        "INSERT INTO deltas (ts, op, payload) VALUES (?, ?, ?)",
        Date.now(),
        d.op,
        JSON.stringify(d.payload ?? {})
      );
      return Response.json({ ok: true });
    }
    if (u.pathname === "/evaluate" && req.method === "POST") {
      const body = await req.json<any>();
      const question = body.question || body.scenario || body.message || "Evaluate risks";
      const snap = this.sql.exec("SELECT * FROM snap").toArray();
      const deltas = this.sql.exec("SELECT * FROM deltas").toArray();
      const prompt = `Digital Twin. Estado (${snap.length} objetos), deltas: ${deltas.length}.
Pregunta: ${question}
Analiza impacto, riesgos y recomendación. Sé breve.`;

      let evaluation = "simulation unavailable";
      try {
        const input = { messages: [{ role: "user", content: prompt }] } as any;
        let r: any;
        if (this.env.AI_GATEWAY_ID) {
          try {
            r = await this.env.AI.run(this.env.CHAT_MODEL as any, input, {
              gateway: { id: this.env.AI_GATEWAY_ID },
            } as any);
          } catch {
            r = await this.env.AI.run(this.env.CHAT_MODEL as any, input);
          }
        } else {
          r = await this.env.AI.run(this.env.CHAT_MODEL as any, input);
        }
        evaluation =
          typeof r?.response === "string"
            ? r.response
            : typeof r === "string"
              ? r
              : JSON.stringify(r);
      } catch (e: any) {
        evaluation = `AI error: ${String(e?.message || e).slice(0, 120)}`;
      }

      try {
        this.sql.exec(
          "UPDATE deltas SET effect = ? WHERE id = (SELECT MAX(id) FROM deltas)",
          evaluation.slice(0, 2000)
        );
      } catch {
        /* no deltas yet */
      }
      return Response.json({ evaluation, deltas: deltas.length });
    }
    if (u.pathname === "/commit" && req.method === "POST") {
      const { identity } = await req.json<any>();
      if (!["confidential", "secret"].includes(identity?.clearance)) {
        return Response.json({ error: "insufficient clearance" }, { status: 403 });
      }
      if (!this.env.DB) {
        return Response.json({ error: "DB required for commit", committed: 0 }, { status: 503 });
      }
      const deltas = this.sql.exec("SELECT * FROM deltas").toArray() as any[];
      let committed = 0;
      for (const d of deltas) {
        const p = JSON.parse(d.payload || "{}");
        if (d.op === "update_object") {
          await this.env.DB.prepare(
            "UPDATE objects SET properties = ?, version = version + 1 WHERE id = ? AND tenant = ?"
          )
            .bind(JSON.stringify(p.changes ?? p), p.id, identity.tenant)
            .run()
            .catch(() => {});
          await emitLineage(this.env, {
            object_id: p.id,
            transformation: "simulation.commit",
            pipeline_version: "v1",
            actor: identity.actor,
            metadata: { from: "simulation" },
          });
          committed++;
        } else if (d.op === "delete_object") {
          await this.env.DB.prepare(
            "UPDATE objects SET valid_to = ?, version = version + 1 WHERE id = ? AND tenant = ?"
          )
            .bind(Date.now(), p.id, identity.tenant)
            .run()
            .catch(() => {});
          committed++;
        }
      }
      return Response.json({ committed });
    }
    // Soft path for factory simulate
    if (u.pathname === "/simulate" && req.method === "POST") {
      const body = await req.json<any>().catch(() => ({}));
      return Response.json({
        ok: true,
        scenario: body.scenario || "generic",
        risk: "low",
        note: "SimulationTwin soft-ack",
      });
    }
    return new Response("not found", { status: 404 });
  }
}

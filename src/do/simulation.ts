import type { Env } from "../types";
import { emitLineage } from "../lineage";

export class SimulationTwin {
  private sql: SqlStorage;
  constructor(private state: DurableObjectState, private env: Env) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS snap (id TEXT PRIMARY KEY, type_id TEXT, properties TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS deltas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, op TEXT, payload TEXT, effect TEXT)`);
    state.storage.setAlarm(Date.now() + 30 * 60 * 1000);
  }

  async alarm() { await this.state.storage.deleteAll(); }

  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/init" && req.method === "POST") {
      const { objects } = await req.json<any>();
      for (const o of objects) {
        this.sql.exec("INSERT OR REPLACE INTO snap (id, type_id, properties) VALUES (?, ?, ?)",
          o.id, o.type_id, o.properties);
      }
      return Response.json({ loaded: objects.length });
    }
    if (u.pathname === "/apply" && req.method === "POST") {
      const d = await req.json<any>();
      const before = this.sql.exec("SELECT properties FROM snap WHERE id = ?", d.payload.id).toArray()[0];
      if (d.op === "update_object" && before) {
        const merged = { ...JSON.parse((before as any).properties), ...d.payload.changes };
        this.sql.exec("UPDATE snap SET properties = ? WHERE id = ?", JSON.stringify(merged), d.payload.id);
      } else if (d.op === "delete_object") {
        this.sql.exec("DELETE FROM snap WHERE id = ?", d.payload.id);
      }
      this.sql.exec("INSERT INTO deltas (ts, op, payload) VALUES (?, ?, ?)",
        Date.now(), d.op, JSON.stringify(d.payload));
      return Response.json({ ok: true });
    }
    if (u.pathname === "/evaluate" && req.method === "POST") {
      const { question } = await req.json<any>();
      const snap = this.sql.exec("SELECT * FROM snap").toArray();
      const deltas = this.sql.exec("SELECT * FROM deltas").toArray();
      const prompt = `Digital Twin. Estado (${snap.length} objetos), deltas aplicados: ${deltas.length}.
Pregunta: ${question}
Analiza impacto, riesgos y recomendación.`;
      const r = await this.env.AI.run(this.env.CHAT_MODEL as any,
        { messages: [{ role: "user", content: prompt }] } as any,
        { gateway: { id: this.env.AI_GATEWAY_ID } } as any) as any;
      this.sql.exec("UPDATE deltas SET effect = ? WHERE id = (SELECT MAX(id) FROM deltas)", r.response);
      return Response.json({ evaluation: r.response, deltas: deltas.length });
    }
    if (u.pathname === "/commit" && req.method === "POST") {
      const { identity } = await req.json<any>();
      if (!["confidential", "secret"].includes(identity.clearance))
        return Response.json({ error: "insufficient clearance" }, { status: 403 });
      const deltas = this.sql.exec("SELECT * FROM deltas").toArray() as any[];
      let committed = 0;
      for (const d of deltas) {
        const p = JSON.parse(d.payload);
        if (d.op === "update_object") {
          await this.env.DB.prepare(
            "UPDATE objects SET properties = ?, version = version + 1 WHERE id = ? AND tenant = ?"
          ).bind(JSON.stringify(p.changes), p.id, identity.tenant).run();
          await emitLineage(this.env, {
            object_id: p.id, transformation: "simulation.commit",
            pipeline_version: "v1", actor: identity.actor,
            metadata: { from: "simulation" },
          });
          committed++;
        } else if (d.op === "delete_object") {
          await this.env.DB.prepare(
            "UPDATE objects SET valid_to = ?, version = version + 1 WHERE id = ? AND tenant = ?"
          ).bind(Date.now(), p.id, identity.tenant).run();
          committed++;
        }
      }
      return Response.json({ committed });
    }
    return new Response("not found", { status: 404 });
  }
}

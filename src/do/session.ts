export class SessionMemory {
  private sql: SqlStorage;
  constructor(state: DurableObjectState, _env: unknown) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, ts INTEGER)`);
  }
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/append" && req.method === "POST") {
      const { role, content } = await req.json<any>();
      this.sql.exec("INSERT INTO history (role, content, ts) VALUES (?, ?, ?)",
        role, content, Date.now());
      this.sql.exec("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 50)");
      return Response.json({ ok: true });
    }
    if (u.pathname === "/get") {
      const rows = this.sql.exec("SELECT role, content, ts FROM history ORDER BY id ASC").toArray();
      return Response.json({ history: rows });
    }
    if (u.pathname === "/reset" && req.method === "POST") {
      this.sql.exec("DELETE FROM history");
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }
}

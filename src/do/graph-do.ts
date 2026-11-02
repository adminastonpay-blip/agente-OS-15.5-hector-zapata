export class GraphResolver {
  private state: DurableObjectState;
  private sql: SqlStorage;
  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY, type_id TEXT, properties TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT, type TEXT)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_e_from ON edges(from_id, type)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_e_to ON edges(to_id, type)`);
  }
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/object" && req.method === "POST") {
      const o = await req.json<any>();
      this.sql.exec("INSERT OR REPLACE INTO nodes (id, type_id, properties) VALUES (?, ?, ?)",
        o.id, o.type_id, JSON.stringify(o.properties));
      return Response.json({ ok: true });
    }
    if (u.pathname === "/link" && req.method === "POST") {
      const l = await req.json<any>();
      this.sql.exec("INSERT OR REPLACE INTO edges (id, from_id, to_id, type) VALUES (?, ?, ?, ?)",
        l.id, l.from_id, l.to_id, l.type);
      return Response.json({ ok: true });
    }
    if (u.pathname === "/neighbors") {
      const id = u.searchParams.get("id")!;
      const type = u.searchParams.get("type");
      const dir = u.searchParams.get("dir") ?? "both";
      const edges: any[] = [];
      if (dir !== "in") edges.push(...this.sql.exec(
        `SELECT id, type, to_id AS peer, 'out' AS direction FROM edges WHERE from_id = ?
         ${type ? "AND type = ?" : ""}`, ...(type ? [id, type] : [id])
      ).toArray());
      if (dir !== "out") edges.push(...this.sql.exec(
        `SELECT id, type, from_id AS peer, 'in' AS direction FROM edges WHERE to_id = ?
         ${type ? "AND type = ?" : ""}`, ...(type ? [id, type] : [id])
      ).toArray());
      const neighbors = edges.map((e) => ({
        ...e,
        object: this.sql.exec("SELECT * FROM nodes WHERE id = ?", e.peer).toArray()[0] ?? null,
      }));
      return Response.json({ id, neighbors });
    }
    if (u.pathname === "/path") {
      const from = u.searchParams.get("from")!;
      const to = u.searchParams.get("to")!;
      const maxD = parseInt(u.searchParams.get("depth") ?? "4");
      const visited = new Set([from]);
      const q: Array<{ id: string; path: string[] }> = [{ id: from, path: [from] }];
      let found: string[] | null = null;
      while (q.length) {
        const { id, path } = q.shift()!;
        if (id === to) { found = path; break; }
        if (path.length >= maxD) continue;
        const nexts = this.sql.exec(
          "SELECT to_id FROM edges WHERE from_id = ? UNION SELECT from_id FROM edges WHERE to_id = ?",
          id, id
        ).toArray() as any[];
        for (const n of nexts) {
          if (!visited.has(n.to_id)) {
            visited.add(n.to_id);
            q.push({ id: n.to_id, path: [...path, n.to_id] });
          }
        }
      }
      return Response.json({ from, to, path: found, found: !!found });
    }
    return new Response("not found", { status: 404 });
  }
}

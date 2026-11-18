/**
 * Durable Object anti-replay store.
 * SQLite primary-key uniqueness makes the claim atomic within this object.
 */
export class ReplayGuard {
  private readonly sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS consumed_mission_jti (
        jti TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/consume" || request.method !== "POST") {
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    const body = await request.json<{ jti?: string; exp?: number }>().catch(() => null);
    if (!body || typeof body.jti !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.jti) ||
        !Number.isSafeInteger(body.exp)) {
      return Response.json({ ok: false, error: "invalid_replay_claim" }, { status: 400 });
    }

    const now = Math.floor(Date.now() / 1000);
    if (body.exp! <= now || body.exp! > now + 15 * 60 + 30) {
      return Response.json({ ok: false, error: "replay_claim_expired_or_too_long" }, { status: 400 });
    }

    try {
      this.sql.exec("DELETE FROM consumed_mission_jti WHERE expires_at <= ?", now);
      this.sql.exec(
        "INSERT OR IGNORE INTO consumed_mission_jti (jti, expires_at, consumed_at) VALUES (?, ?, ?)",
        body.jti, body.exp, now
      );
      const inserted = Number(
        (this.sql.exec("SELECT changes() AS inserted").toArray()[0] as { inserted: number } | undefined)?.inserted ?? 0
      );
      return inserted === 1
        ? Response.json({ ok: true, fresh: true })
        : Response.json({ ok: false, fresh: false, error: "mission_token_replay" }, { status: 409 });
    } catch {
      return Response.json({ ok: false, error: "replay_store_unavailable" }, { status: 503 });
    }
  }
}

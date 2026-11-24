/**
 * Durable Object anti-replay store.
 * SQLite primary-key uniqueness and synchronous transactionSync make claims atomic.
 */
export interface ReplayTransactionStorage {
  transactionSync<T>(closure: () => T): T;
}

export class ReplayGuard {
  private readonly state: DurableObjectState;
  private readonly sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS consumed_mission_jti (
        jti TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS consumed_gate_nonces (
        nonce_key TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || (url.pathname !== "/consume" && url.pathname !== "/consume-nonce")) {
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }

    const storage = this.state?.storage as (DurableObjectStorage & Partial<ReplayTransactionStorage>) | undefined;
    if (!storage || typeof storage.transactionSync !== "function") {
      return Response.json({ ok: false, error: "replay_store_unavailable" }, { status: 503 });
    }

    if (url.pathname === "/consume-nonce") {
      const body = await request.json<{
        nonce_key?: string;
        scope?: string;
        expires_at?: number;
        max_ttl_ms?: number;
      }>().catch(() => null);

      if (
        !body ||
        typeof body.nonce_key !== "string" ||
        body.nonce_key.length < 8 ||
        body.nonce_key.length > 256 ||
        typeof body.scope !== "string" ||
        !/^[a-zA-Z0-9:._-]{1,128}$/.test(body.scope) ||
        !Number.isSafeInteger(body.expires_at)
      ) {
        return Response.json({ ok: false, error: "invalid_nonce_claim" }, { status: 400 });
      }

      const nowMs = Date.now();
      const maxTtlMs =
        body.max_ttl_ms !== undefined && Number.isSafeInteger(body.max_ttl_ms) && body.max_ttl_ms > 0
          ? Math.min(body.max_ttl_ms, 60_000)
          : 15_000;
      const expiresAtMs = Number(body.expires_at);

      if (expiresAtMs <= nowMs || expiresAtMs > nowMs + maxTtlMs + 5_000) {
        return Response.json({ ok: false, error: "nonce_expired_or_ttl_exceeded" }, { status: 400 });
      }

      try {
        const fresh = storage.transactionSync(() => {
          this.sql.exec("DELETE FROM consumed_gate_nonces WHERE expires_at <= ?", nowMs);
          this.sql.exec(
            `INSERT OR IGNORE INTO consumed_gate_nonces (nonce_key, scope, expires_at, consumed_at)
             VALUES (?, ?, ?, ?)`,
            body.nonce_key,
            body.scope,
            expiresAtMs,
            nowMs
          );
          const inserted = Number(
            (this.sql.exec("SELECT changes() AS inserted").toArray()[0] as { inserted?: number } | undefined)
              ?.inserted ?? 0
          );
          return inserted === 1;
        });

        return fresh
          ? Response.json({ ok: true, fresh: true })
          : Response.json({ ok: false, fresh: false, error: "nonce_replay" }, { status: 409 });
      } catch {
        return Response.json({ ok: false, error: "replay_store_unavailable" }, { status: 503 });
      }
    }

    const body = await request.json<{ jti?: string; exp?: number }>().catch(() => null);
    if (
      !body ||
      typeof body.jti !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.jti) ||
      !Number.isSafeInteger(body.exp)
    ) {
      return Response.json({ ok: false, error: "invalid_replay_claim" }, { status: 400 });
    }

    const now = Math.floor(Date.now() / 1000);
    if (body.exp! <= now || body.exp! > now + 15 * 60 + 30) {
      return Response.json({ ok: false, error: "replay_claim_expired_or_too_long" }, { status: 400 });
    }

    try {
      const inserted = storage.transactionSync(() => {
        this.sql.exec("DELETE FROM consumed_mission_jti WHERE expires_at <= ?", now);
        this.sql.exec(
          "INSERT OR IGNORE INTO consumed_mission_jti (jti, expires_at, consumed_at) VALUES (?, ?, ?)",
          body.jti,
          body.exp,
          now
        );
        return Number(
          (this.sql.exec("SELECT changes() AS inserted").toArray()[0] as { inserted?: number } | undefined)
            ?.inserted ?? 0
        );
      });

      return inserted === 1
        ? Response.json({ ok: true, fresh: true })
        : Response.json({ ok: false, fresh: false, error: "mission_token_replay" }, { status: 409 });
    } catch {
      return Response.json({ ok: false, error: "replay_store_unavailable" }, { status: 503 });
    }
  }
}

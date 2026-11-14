/**
 * SafetyInterlock Durable Object — Aston OS 15.5
 *
 * Capa de seguridad que:
 * 1. Evalúa cada acción propuesta (policy engine)
 * 2. Puede exigir aprobación humana (human-in-the-loop)
 * 3. Registra todo en journal + lineage
 * 4. (Opcional) Ejecuta código no confiable dentro de un Sandbox aislado
 *
 * Listo para integrar Cloudflare Containers / Sandbox SDK cuando el binding esté disponible.
 */

import type { Env, Identity } from "../types";
import { evaluatePolicy, type ProposedAction, type PolicyResult } from "../safety/policy";
import { emitLineage } from "../lineage";
import { hashAuditRecord, verifyAuditChain } from "../security/audit-chain";
import { sha256Hex, writeImmutableCheckpoint, verifyExternalOtsAnchor } from "../security/audit-anchor";

export class SafetyInterlock {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        action_json TEXT,
        identity_json TEXT,
        policy_json TEXT,
        created_at INTEGER,
        expires_at INTEGER,
        status TEXT,
        decided_by TEXT,
        decided_at INTEGER
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS execution_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        action_tool TEXT,
        decision TEXT,
        risk TEXT,
        score INTEGER,
        actor TEXT,
        detail TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL, tenant TEXT NOT NULL, actor TEXT NOT NULL,
        event_type TEXT NOT NULL, record_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL,
        UNIQUE (tenant, previous_hash)
      )
    `);
    this.sql.exec(`CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events_are_immutable'); END`);
    this.sql.exec(`CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events_are_immutable'); END`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS audit_anchor_state (tenant TEXT PRIMARY KEY, anchored_count INTEGER NOT NULL, root_hash TEXT NOT NULL, object_key TEXT NOT NULL, anchored_at INTEGER NOT NULL)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS audit_claims (
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, case_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS request_rate_windows (
        window_start INTEGER PRIMARY KEY,
        request_count INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS audit_rate_windows (
        window_start INTEGER PRIMARY KEY,
        request_count INTEGER NOT NULL
      )
    `);
  }

  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);

    if (u.pathname === "/rate-limit/check" && req.method === "POST") {
      const body = await req.json<{ limit: number; window_ms: number }>().catch(() => null);
      if (!body || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 10000 ||
          !Number.isInteger(body.window_ms) || body.window_ms < 1000 || body.window_ms > 3600000) {
        return Response.json({ error: "invalid_rate_limit_policy" }, { status: 400 });
      }
      const now = Date.now();
      const windowStart = Math.floor(now / body.window_ms) * body.window_ms;
      this.sql.exec("DELETE FROM request_rate_windows WHERE window_start < ?", now - 3600000);
      this.sql.exec(`INSERT INTO request_rate_windows (window_start, request_count)
        VALUES (?, 1) ON CONFLICT(window_start) DO UPDATE SET request_count = request_count + 1`, windowStart);
      const count = Number((this.sql.exec("SELECT request_count FROM request_rate_windows WHERE window_start = ?", windowStart)
        .toArray()[0] as any)?.request_count ?? 0);
      const allowed = count <= body.limit;
      return Response.json({ allowed, remaining: Math.max(0, body.limit - count),
        reset_at: windowStart + body.window_ms }, { status: allowed ? 200 : 429 });
    }

    if (u.pathname === "/audit/claim" && req.method === "POST") {
      const body = await req.json<{ run_id: string; case_id: string }>().catch(() => null);
      if (
        !body ||
        typeof body.run_id !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,63}$/.test(body.run_id) ||
        typeof body.case_id !== "string" ||
        !/^[A-Z0-9][A-Z0-9_-]{2,63}$/.test(body.case_id)
      ) {
        return Response.json({ error: "invalid audit claim" }, { status: 400 });
      }

      const now = Date.now();
      const minuteWindow = Math.floor(now / 60000) * 60000;
      const hourWindow = now - 3600000;
      this.sql.exec("DELETE FROM audit_claims WHERE created_at < ?", now - 86400000);
      this.sql.exec("DELETE FROM audit_rate_windows WHERE window_start < ?", now - 3600000);
      this.sql.exec(
        `INSERT INTO audit_rate_windows (window_start, request_count)
         VALUES (?, 1)
         ON CONFLICT(window_start) DO UPDATE SET request_count = request_count + 1`,
        minuteWindow
      );
      const minuteCount = Number(
        (this.sql.exec("SELECT request_count FROM audit_rate_windows WHERE window_start = ?", minuteWindow)
          .toArray()[0] as any)?.request_count ?? 0
      );
      const hourCount = Number(
        (this.sql.exec("SELECT COALESCE(SUM(request_count), 0) AS total FROM audit_rate_windows WHERE window_start >= ?", hourWindow)
          .toArray()[0] as any)?.total ?? 0
      );
      if (minuteCount > 2 || hourCount > 10) {
        return Response.json({ error: "audit_rate_limit_exceeded" }, { status: 429 });
      }

      this.sql.exec(
        "INSERT OR IGNORE INTO audit_claims (run_id, case_id, created_at) VALUES (?, ?, ?)",
        body.run_id,
        body.case_id,
        now
      );
      const inserted = Number(
        (this.sql.exec("SELECT changes() AS inserted").toArray()[0] as any)?.inserted ?? 0
      );
      if (inserted !== 1) {
        return Response.json({ error: "audit_case_replay" }, { status: 409 });
      }
      return Response.json({ status: "claimed", run_id: body.run_id, case_id: body.case_id });
    }
    if (u.pathname === "/audit/append" && req.method === "POST") {
      const body = await req.json<{ tenant: string; actor: string; event_type: string; payload?: Record<string, unknown> }>().catch(() => null);
      const allowedEvents = new Set(["agent.plan.created", "agent.plan.rejected", "agent.plan.approved", "agent.plan.rejected_by_human", "agent.action.executed", "agent.action.blocked"]);
      if (!body || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.tenant) || typeof body.actor !== "string" || !body.actor || body.actor.length > 128 || !allowedEvents.has(body.event_type) || !body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
        return Response.json({ ok: false, error: "invalid_audit_event" }, { status: 400 });
      }
      await this.appendAuditEvent(body.tenant, body.actor, body.event_type, body.payload);
      return Response.json({ ok: true, recorded: true });
    }

    if (u.pathname === "/audit/anchor/verify" && req.method === "POST") {
      if (!this.env.AUDIT_ARCHIVE || !this.env.OTS_VERIFIER) return Response.json({ ok: false, error: "external_anchor_verification_unavailable" }, { status: 503 });
      const body = await req.json<{ tenant: string; event_count: number }>().catch(() => null);
      if (!body || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.tenant) || !Number.isSafeInteger(body.event_count) || body.event_count < 1) return Response.json({ ok: false, error: "invalid_anchor_reference" }, { status: 400 });
      const tenantHash = await sha256Hex(body.tenant);
      const prefix = "evidence/anchors/v1/" + tenantHash + "/" + String(body.event_count).padStart(12, "0") + "-";
      const objects = await this.env.AUDIT_ARCHIVE.list({ prefix, limit: 2 });
      if (objects.objects.length !== 1) return Response.json({ ok: false, error: "anchor_not_found_or_ambiguous" }, { status: 404 });
      const objectKey = objects.objects[0].key;
      const manifestObject = await this.env.AUDIT_ARCHIVE.get(objectKey);
      if (!manifestObject) return Response.json({ ok: false, error: "anchor_manifest_missing" }, { status: 503 });
      const manifest = await manifestObject.json<{ root_hash: string }>();
      if (!/^[a-f0-9]{64}$/.test(manifest.root_hash)) return Response.json({ ok: false, integrity: false, error: "anchor_manifest_invalid" }, { status: 409 });
      const localRoot = this.sql.exec(
        "SELECT event_hash FROM audit_events WHERE tenant = ? ORDER BY id ASC LIMIT 1 OFFSET ?",
        body.tenant, body.event_count - 1
      ).toArray()[0] as { event_hash: string } | undefined;
      if (localRoot && localRoot.event_hash !== manifest.root_hash) {
        return Response.json({ ok: false, integrity: false, error: "local_root_mismatch" }, { status: 409 });
      }
      const verified = await verifyExternalOtsAnchor(this.env.OTS_VERIFIER, this.env.AUDIT_ARCHIVE, objectKey, manifest.root_hash);
      if (!verified.ok) return Response.json({ ok: false, integrity: false, reason: verified.reason }, { status: 503 });
      return Response.json({ ok: true, integrity: true, local_state_missing: !localRoot,
        tenant_hash: tenantHash, event_count: body.event_count, root_hash: manifest.root_hash,
        bitcoin_block_height: verified.block_height, bitcoin_timestamp: verified.timestamp });
    }

    if (u.pathname === "/audit/verify" && req.method === "GET") {
      const tenant = u.searchParams.get("tenant") || "";
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenant)) return Response.json({ error: "invalid_tenant" }, { status: 400 });
      const rows = this.sql.exec("SELECT record_json, previous_hash, event_hash FROM audit_events WHERE tenant = ? ORDER BY id ASC", tenant).toArray() as Array<{ record_json: string; previous_hash: string; event_hash: string }>;
      const intact = await verifyAuditChain(rows.map((row) => ({ record: row.record_json, previousHash: row.previous_hash, hash: row.event_hash })));
      return Response.json({ tenant, intact, events: rows.length });
    }

    if (u.pathname === "/evaluate" && req.method === "POST") {
      const body = await req.json<{ action: ProposedAction; identity: Identity }>();
      const result = await this.evaluateAndGate(body.action, body.identity);
      return Response.json(result, { status: result.status === "denied" ? 403 : 200 });
    }

    if (u.pathname === "/pending" && req.method === "GET") {
      const rows = this.sql
        .exec(
          `SELECT id, action_json, policy_json, created_at, expires_at, status
           FROM pending_approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50`
        )
        .toArray() as any[];
      return Response.json({
        pending: rows.map((r) => ({
          id: r.id,
          action: JSON.parse(r.action_json),
          policy: JSON.parse(r.policy_json),
          created_at: r.created_at,
          expires_at: r.expires_at,
        })),
      });
    }

    if (u.pathname === "/decide" && req.method === "POST") {
      const { approval_id, approved, operator } = await req.json<{
        approval_id: string;
        approved: boolean;
        operator: string;
      }>();
      return Response.json(await this.decide(approval_id, approved, operator));
    }

    if (u.pathname === "/sandbox/exec" && req.method === "POST") {
      const body = await req.json<{
        code: string;
        language?: "javascript" | "python" | "bash";
        identity: Identity;
        timeout_ms?: number;
      }>();
      return Response.json(await this.sandboxExec(body));
    }

    if (u.pathname === "/log" && req.method === "GET") {
      const limit = parseInt(u.searchParams.get("limit") ?? "30");
      const rows = this.sql
        .exec(
          `SELECT ts, action_tool, decision, risk, score, actor, detail
           FROM execution_log ORDER BY id DESC LIMIT ?`,
          limit
        )
        .toArray();
      return Response.json({ entries: rows });
    }

    return new Response("not found", { status: 404 });
  }

  private async appendAuditEvent(tenant: string, actor: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    if (this.env.AUDIT_ANCHOR_REQUIRED === "true" && !this.env.AUDIT_ARCHIVE) throw new Error("audit_anchor_required_but_r2_binding_missing");
    const ts = Date.now();
    const record = JSON.stringify({ ts, tenant, actor, event_type: eventType, payload });
    // The unique tenant/previous_hash key prevents concurrent writers from forking a chain.
    for (let attempt = 0; attempt < 8; attempt++) {
      const previousHash = String((this.sql.exec(
        "SELECT event_hash FROM audit_events WHERE tenant = ? ORDER BY id DESC LIMIT 1", tenant
      ).toArray()[0] as any)?.event_hash ?? "GENESIS");
      const eventHash = await hashAuditRecord(previousHash, record);
      try {
        this.sql.exec("INSERT INTO audit_events (ts, tenant, actor, event_type, record_json, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ts, tenant, actor, eventType, record, previousHash, eventHash);
        if (this.env.AUDIT_ARCHIVE) {
          try {
            await this.maybeAnchorTenant(tenant, false);
            if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(Date.now() + 3600000);
          } catch (error) {
            if (this.env.AUDIT_ANCHOR_REQUIRED === "true") throw error;
          }
        }
        return;
      } catch (error) {
        if (attempt === 7) throw error;
      }
    }
    throw new Error("audit_chain_append_conflict");
  }

  private async maybeAnchorTenant(tenant: string, force: boolean): Promise<void> {
    const count = Number((this.sql.exec("SELECT COUNT(*) AS count FROM audit_events WHERE tenant = ?", tenant).toArray()[0] as any)?.count ?? 0);
    const state = this.sql.exec("SELECT anchored_count, root_hash FROM audit_anchor_state WHERE tenant = ?", tenant).toArray()[0] as { anchored_count: number; root_hash: string } | undefined;
    const anchoredCount = Number(state?.anchored_count ?? 0);
    if (count <= anchoredCount || (!force && count - anchoredCount < 100)) return;
    if (!this.env.AUDIT_ARCHIVE) { if (this.env.AUDIT_ANCHOR_REQUIRED === "true") throw new Error("audit_archive_binding_missing"); return; }
    const first = this.sql.exec("SELECT event_hash FROM audit_events WHERE tenant = ? ORDER BY id ASC LIMIT 1", tenant).toArray()[0] as { event_hash: string } | undefined;
    const last = this.sql.exec("SELECT event_hash, ts FROM audit_events WHERE tenant = ? ORDER BY id DESC LIMIT 1", tenant).toArray()[0] as { event_hash: string; ts: number } | undefined;
    if (!first || !last) return;
    const checkpoint = { schema: "aston.audit.checkpoint.v1" as const, tenant_hash: await sha256Hex(tenant), event_count: count, root_hash: last.event_hash, previous_anchor_root: state?.root_hash ?? "GENESIS", first_event_hash: first.event_hash, last_event_hash: last.event_hash, last_event_ts: Number(last.ts), created_at: Date.now() };
    const written = await writeImmutableCheckpoint(this.env.AUDIT_ARCHIVE, checkpoint);
    this.sql.exec("INSERT INTO audit_anchor_state (tenant, anchored_count, root_hash, object_key, anchored_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant) DO UPDATE SET anchored_count = excluded.anchored_count, root_hash = excluded.root_hash, object_key = excluded.object_key, anchored_at = excluded.anchored_at", tenant, count, checkpoint.root_hash, written.key, Date.now());
  }

  async alarm(): Promise<void> {
    if (!this.env.AUDIT_ARCHIVE) { if (this.env.AUDIT_ANCHOR_REQUIRED === "true") throw new Error("audit_archive_binding_missing"); return; }
    const tenants = this.sql.exec("SELECT DISTINCT tenant FROM audit_events").toArray() as Array<{ tenant: string }>;
    for (const row of tenants) await this.maybeAnchorTenant(row.tenant, true);
    await this.state.storage.setAlarm(Date.now() + 3600000);
  }
  private async evaluateAndGate(action: ProposedAction, identity: Identity) {
    const policy = evaluatePolicy(action, identity);

    this.sql.exec(
      `INSERT INTO execution_log (ts, action_tool, decision, risk, score, actor, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      Date.now(),
      action.tool,
      policy.decision,
      policy.risk,
      policy.score,
      identity.actor,
      JSON.stringify(policy.reasons)
    );

    await this.appendAuditEvent(identity.tenant, identity.actor, "agent.policy_decision", {
      tool: action.tool, decision: policy.decision, risk: policy.risk,
      score: policy.score, reasons: policy.reasons,
    });

    await emitLineage(this.env, {
      object_id: `safety_${crypto.randomUUID()}`,
      transformation: `safety.${policy.decision}`,
      pipeline_version: "v15.5",
      actor: identity.actor,
      metadata: {
        tool: action.tool,
        risk: policy.risk,
        score: policy.score,
        reasons: policy.reasons,
      },
    });

    if (policy.decision === "allow") {
      return {
        status: "allowed",
        policy,
        message: "Acción permitida por política de seguridad",
      };
    }

    if (policy.decision === "deny") {
      return {
        status: "denied",
        policy,
        message: "Acción denegada por política de seguridad",
      };
    }

    const id = `apr_${crypto.randomUUID()}`;
    const now = Date.now();
    const expires = now + (policy.expires_in_ms ?? 4 * 60 * 60 * 1000);

    this.sql.exec(
      `INSERT INTO pending_approvals
       (id, action_json, identity_json, policy_json, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      id,
      JSON.stringify(action),
      JSON.stringify(identity),
      JSON.stringify(policy),
      now,
      expires
    );

    return {
      status: "pending_approval",
      approval_id: id,
      policy,
      expires_at: expires,
      message: "Acción requiere aprobación humana. Use POST /decide",
    };
  }

  private async decide(approvalId: string, approved: boolean, operator: string) {
    const row = this.sql
      .exec(`SELECT * FROM pending_approvals WHERE id = ?`, approvalId)
      .toArray()[0] as any;

    if (!row) return { error: "approval not found", status: 404 };
    if (row.status !== "pending") return { error: `already ${row.status}`, status: 409 };
    if (Date.now() > row.expires_at) {
      this.sql.exec(`UPDATE pending_approvals SET status = 'expired' WHERE id = ?`, approvalId);
      return { error: "approval expired", status: 410 };
    }

    const newStatus = approved ? "approved" : "rejected";
    this.sql.exec(
      `UPDATE pending_approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
      newStatus, operator, Date.now(), approvalId
    );

    this.sql.exec(
      `INSERT INTO execution_log (ts, action_tool, decision, risk, score, actor, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      Date.now(),
      JSON.parse(row.action_json).tool,
      newStatus,
      JSON.parse(row.policy_json).risk,
      JSON.parse(row.policy_json).score,
      operator,
      `Human decision by ${operator}`
    );

    const originalIdentity = JSON.parse(row.identity_json) as Identity;
    await this.appendAuditEvent(originalIdentity.tenant, operator, "approval.decision", {
      approval_id: approvalId, decision: newStatus, original_actor: originalIdentity.actor,
    });

    await emitLineage(this.env, {
      object_id: approvalId,
      transformation: `safety.human_${newStatus}`,
      pipeline_version: "v15.5",
      actor: operator,
      metadata: { original_actor: JSON.parse(row.identity_json).actor },
    });

    return {
      status: newStatus,
      approval_id: approvalId,
      action: JSON.parse(row.action_json),
      decided_by: operator,
    };
  }

  private async sandboxExec(opts: {
    code: string;
    language?: "javascript" | "python" | "bash";
    identity: Identity;
    timeout_ms?: number;
  }) {
    const action: ProposedAction = {
      tool: "run_code",
      args: {
        language: opts.language ?? "javascript",
        code_preview: opts.code.slice(0, 200),
        length: opts.code.length,
      },
    };

    const gate = await this.evaluateAndGate(action, opts.identity);

    if (gate.status === "denied") {
      return { status: "denied", reason: gate.policy?.reasons };
    }
    if (gate.status === "pending_approval") {
      return {
        status: "pending_approval",
        approval_id: gate.approval_id,
        message: "Ejecución de código requiere aprobación humana",
      };
    }

    // Placeholder fail-closed hasta activar Containers binding
    return {
      status: "sandbox_ready",
      message:
        "SafetyInterlock listo. Active el binding de Containers en wrangler.toml para ejecución real de código no confiable.",
      policy: gate.policy,
      note: "Fail-closed: no se ejecuta código hasta que el sandbox esté configurado.",
    };
  }
}

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
 *
 * Schema notes (Gate A):
 * - execution_log is created BEFORE any INSERT that targets it
 * - ALTER TABLE always inserts a space between column name and type
 * - Legacy approvals without agent_id/credential_id are fail-closed to EXPIRED_LEGACY_UNBOUND
 */

import type { Env, Identity } from "../types";
import { evaluatePolicy, type ProposedAction, type PolicyResult } from "../safety/policy";
import { emitLineage } from "../lineage";
import { hashAuditRecord, verifyAuditChain } from "../security/audit-chain";
import { sha256Hex, writeImmutableCheckpoint, verifyExternalOtsAnchor } from "../security/audit-anchor";
import {
  importEd25519PrivateKey,
  importEd25519PublicKey,
  signAttestation,
  verifyAttestation,
  verifyInternalAssertion,
  type AttestationEnvelope,
} from "../core/attestation";
import {
  assertCryptographicReadiness,
  claimOrRecoverLease,
  finalizeApprovalWithLease,
  ControlAssuranceError,
} from "../core/control-assurance";

type SafetyEnv = Env & {
  INTERNAL_ASSERTION_SECRET?: string;
  INTERNAL_ASSERTION_KEY_ID?: string;
};

export class SafetyInterlock {
  private state: DurableObjectState;
  private env: SafetyEnv;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: SafetyEnv) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;

    // Base tables first (execution_log must exist before any INSERT)
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
    this.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events_are_immutable'); END`
    );
    this.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events_are_immutable'); END`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS decision_attestations (
        attestation_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, actor TEXT NOT NULL,
        decision TEXT NOT NULL, envelope_json TEXT NOT NULL, created_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS audit_anchor_state (
        tenant TEXT PRIMARY KEY, anchored_count INTEGER NOT NULL, root_hash TEXT NOT NULL,
        object_key TEXT NOT NULL, anchored_at INTEGER NOT NULL
      )
    `);
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

    // Gate A authoritative registry tables
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, agent_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_credentials (
        credential_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        public_key_jwk_or_pem TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS admin_command_nonces (
        nonce_key TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS internal_assertion_nonces (
        jti TEXT PRIMARY KEY,
        aud TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL
      )
    `);

    // Idempotent column migrations (space required between column name and type)
    const approvalColumns = new Set(
      this.sql
        .exec<Record<string, SqlStorageValue>>("PRAGMA table_info(pending_approvals)")
        .toArray()
        .map((row) => String(row.name))
    );
    const extraColumns: Array<[string, string]> = [
      ["lease_id", "TEXT"],
      ["lease_expires_at", "INTEGER"],
      ["processing_attempt", "INTEGER NOT NULL DEFAULT 0"],
      ["fencing_token", "INTEGER NOT NULL DEFAULT 0"],
      ["agent_id", "TEXT"],
      ["credential_id", "TEXT"],
    ];
    for (const [column, definition] of extraColumns) {
      if (!approvalColumns.has(column)) {
        this.sql.exec(`ALTER TABLE pending_approvals ADD COLUMN ${column} ${definition}`);
      }
    }

    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_pending_approvals_status_expiry ON pending_approvals(status, expires_at)"
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_pending_approvals_processing_lease ON pending_approvals(status, lease_expires_at) WHERE status = 'processing'"
    );

    // Fail-closed migration: invalidate legacy approvals lacking agent/credential binding
    const legacyUnboundRows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT id, identity_json FROM pending_approvals
         WHERE status IN ('pending', 'processing')
           AND (agent_id IS NULL OR TRIM(agent_id) = '' OR credential_id IS NULL OR TRIM(credential_id) = '')`
      )
      .toArray();

    if (legacyUnboundRows.length > 0) {
      const migratedAt = Date.now();
      this.sql.exec(
        `UPDATE pending_approvals
         SET status = 'EXPIRED_LEGACY_UNBOUND',
             lease_id = NULL,
             lease_expires_at = NULL,
             decided_at = COALESCE(decided_at, ?)
         WHERE status IN ('pending', 'processing')
           AND (agent_id IS NULL OR TRIM(agent_id) = '' OR credential_id IS NULL OR TRIM(credential_id) = '')`,
        migratedAt
      );
      for (const row of legacyUnboundRows) {
        let tenant = "unknown";
        try {
          const parsed = JSON.parse(String(row.identity_json ?? "{}"));
          if (typeof parsed?.tenant === "string" && parsed.tenant) tenant = parsed.tenant;
        } catch {
          tenant = "unknown";
        }
        this.sql.exec(
          `INSERT INTO execution_log (ts, action_tool, decision, risk, score, actor, detail)
           VALUES (?, 'legacy_approval', 'EXPIRED_LEGACY_UNBOUND', 'high', 100, 'gate-a-migration', ?)`,
          migratedAt,
          JSON.stringify({
            approval_id: String(row.id),
            tenant,
            reason: "missing_agent_or_credential_binding",
          })
        );
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/evaluate" && request.method === "POST") {
        const body = await request.json() as { action: ProposedAction; identity: Identity };
        const result = await this.evaluateAndGate(body.action, body.identity);
        return Response.json(result);
      }

      if (path === "/approve" && request.method === "POST") {
        const body = await request.json() as {
          approval_id: string;
          approved: boolean;
          operator: string;
        };
        const result = await this.decideApproval(body.approval_id, body.approved, body.operator);
        return Response.json(result);
      }

      if (path === "/sandbox" && request.method === "POST") {
        const body = await request.json() as {
          code: string;
          language?: "javascript" | "python" | "bash";
          identity: Identity;
          timeout_ms?: number;
        };
        const result = await this.sandboxExec(body);
        return Response.json(result);
      }

      if (path === "/health") {
        return Response.json({ ok: true, service: "safety-interlock" });
      }

      return Response.json({ error: "not_found", path }, { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: "internal", message }, { status: 500 });
    }
  }

  private async evaluateAndGate(
    action: ProposedAction,
    identity: Identity
  ): Promise<{
    status: "allowed" | "denied" | "pending_approval";
    policy?: PolicyResult;
    approval_id?: string;
    reasons?: string[];
  }> {
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
      JSON.stringify(policy.reasons ?? [])
    );

    await this.appendAuditEvent(identity.tenant, identity.actor, "policy.evaluate", {
      tool: action.tool,
      decision: policy.decision,
      risk: policy.risk,
      score: policy.score,
    });

    if (policy.decision === "deny") {
      return { status: "denied", policy, reasons: policy.reasons };
    }

    if (policy.decision === "require_approval") {
      const approvalId = crypto.randomUUID();
      const now = Date.now();
      this.sql.exec(
        `INSERT INTO pending_approvals
         (id, action_json, identity_json, policy_json, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        approvalId,
        JSON.stringify(action),
        JSON.stringify(identity),
        JSON.stringify(policy),
        now,
        now + 30 * 60 * 1000
      );
      return { status: "pending_approval", policy, approval_id: approvalId };
    }

    return { status: "allowed", policy };
  }

  private async appendAuditEvent(
    tenant: string,
    actor: string,
    eventType: string,
    record: Record<string, unknown>
  ): Promise<void> {
    const ts = Date.now();
    const previous = this.sql
      .exec<{ event_hash: string }>(
        `SELECT event_hash FROM audit_events WHERE tenant = ? ORDER BY id DESC LIMIT 1`,
        tenant
      )
      .toArray();
    const previousHash = previous[0]?.event_hash ?? "genesis";
    const recordJson = JSON.stringify({ ts, tenant, actor, event_type: eventType, ...record });
    const eventHash = await hashAuditRecord(previousHash, recordJson);
    this.sql.exec(
      `INSERT INTO audit_events (ts, tenant, actor, event_type, record_json, previous_hash, event_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ts,
      tenant,
      actor,
      eventType,
      recordJson,
      previousHash,
      eventHash
    );
  }

  private async decideApproval(
    approvalId: string,
    approved: boolean,
    operator: string
  ): Promise<Record<string, unknown>> {
    const rows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM pending_approvals WHERE id = ?`,
        approvalId
      )
      .toArray();
    if (rows.length === 0) {
      return { error: "approval not found", status: 404 };
    }
    const row = rows[0];
    if (String(row.status) !== "pending") {
      return { error: "approval already decided", status: 409, current: row.status };
    }
    if (Number(row.expires_at) < Date.now()) {
      this.sql.exec(`UPDATE pending_approvals SET status = 'expired' WHERE id = ?`, approvalId);
      return { error: "approval expired", status: 410 };
    }

    const newStatus = approved ? "approved" : "rejected";
    this.sql.exec(
      `UPDATE pending_approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
      newStatus,
      operator,
      Date.now(),
      approvalId
    );

    this.sql.exec(
      `INSERT INTO execution_log (ts, action_tool, decision, risk, score, actor, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      Date.now(),
      JSON.parse(String(row.action_json)).tool,
      newStatus,
      JSON.parse(String(row.policy_json)).risk,
      JSON.parse(String(row.policy_json)).score,
      operator,
      `Human decision by ${operator}`
    );

    const originalIdentity = JSON.parse(String(row.identity_json)) as Identity;
    await this.appendAuditEvent(originalIdentity.tenant, operator, "approval.decision", {
      approval_id: approvalId,
      decision: newStatus,
      original_actor: originalIdentity.actor,
    });

    await emitLineage(this.env, {
      tenant: originalIdentity.tenant,
      object_id: approvalId,
      transformation: `safety.human_${newStatus}`,
      pipeline_version: "v15.5",
      actor: operator,
      metadata: { original_actor: originalIdentity.actor },
    });

    return {
      status: newStatus,
      approval_id: approvalId,
      action: JSON.parse(String(row.action_json)),
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

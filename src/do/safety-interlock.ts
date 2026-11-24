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
    // Idempotent SQLite migration: add lease fields without rebuilding existing tables.
    const approvalColumns = new Set(
      this.sql
        .exec<Record<string, SqlStorageValue>>("PRAGMA table_info(pending_approvals)")
        .toArray()
        .map((row) => String(row.name))
    );
    const leaseColumns: Array<[string, string]> = [
      ["lease_id", "TEXT"],
      ["lease_expires_at", "INTEGER"],
      ["processing_attempt", "INTEGER NOT NULL DEFAULT 0"],
      ["fencing_token", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [column, definition] of leaseColumns) {
      if (!approvalColumns.has(column)) {
        this.sql.exec(`ALTER TABLE pending_approvals ADD COLUMN ${column}${definition}`);
      }
    }
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_pending_approvals_status_expiry ON pending_approvals(status, expires_at)"
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_pending_approvals_processing_lease ON pending_approvals(status, lease_expires_at) WHERE status = 'processing'"
    );

    // Gate A: migración idempotente de vinculación a credencial/agente y saneo fail-closed de aprobaciones heredadas
    for (const [column, definition] of [
      ["agent_id", "TEXT"],
      ["credential_id", "TEXT"],
    ] as Array<[string, string]>) {
      if (!approvalColumns.has(column)) {
        this.sql.exec(`ALTER TABLE pending_approvals ADD COLUMN ${column}${definition}`);
      }
    }

    // Marca como EXPIRED_LEGACY_UNBOUND cualquier aprobación abierta sin agent_id o credential_id
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

    // Tablas autoritativas de Gate A y anti-replay (consumo atómico en transactionSync)
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


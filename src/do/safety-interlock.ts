/**
 * SafetyInterlock Durable Object — Aston OS 15.5
 *
 * Schema notes (Gate A):
 * - execution_log is created BEFORE any INSERT that targets it
 * - ALTER TABLE always inserts a space between column name and type
 * - Legacy approvals without agent_id/credential_id are fail-closed to EXPIRED_LEGACY_UNBOUND
 * - Human approval finalization uses atomic leases (claimOrRecoverLease + finalizeApprovalWithLease)
 * - /evaluate consumes internal assertion jti atomically when keys are configured
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
  consumeNonceSync,
  ControlAssuranceError,
} from "../core/control-assurance";

type SafetyEnv = Env & {
  INTERNAL_ASSERTION_SECRET?: string;
  INTERNAL_ASSERTION_KEY_ID?: string;
  ATTESTATION_PRIVATE_KEY?: string;
  ATTESTATION_PUBLIC_KEY?: string;
  ATTESTATION_KEY_ID?: string;
  TRUST?: DurableObjectNamespace;
  /** Explicitly enabled only by unit-test harnesses; never set in deployed Worker environments. */
  SAFETY_INTERLOCK_TEST_MODE?: "true";
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
        const secret = this.env.INTERNAL_ASSERTION_SECRET;
        const kid = this.env.INTERNAL_ASSERTION_KEY_ID;
        const assertionConfigured = Boolean(secret || kid);
        const body = await request.json().catch(() => null) as
          | { action?: ProposedAction; identity?: Identity }
          | null;
        if (!body || !body.action || typeof body.action.tool !== "string" ||
            !body.action.args || typeof body.action.args !== "object" || Array.isArray(body.action.args)) {
          return Response.json({ error: "invalid_evaluation_request", code: "INVALID_EVALUATION_REQUEST" }, { status: 400 });
        }

        let boundIdentity: Identity;
        let principalBinding: { agent_id?: string; credential_id?: string } = {};
        if (assertionConfigured) {
          if (!secret || !kid) {
            return Response.json(
              { error: "internal_assertion_secret_or_kid_missing", code: "INTERNAL_ASSERTION_CONFIG_MISSING" },
              { status: 503 }
            );
          }
          const token = request.headers.get("x-aston-internal-assertion")?.trim() || "";
          if (!token) {
            return Response.json(
              { error: "internal_assertion_required", code: "INTERNAL_ASSERTION_REQUIRED" },
              { status: 401 }
            );
          }
          const verified = await verifyInternalAssertion(token, secret, kid, "safety-interlock");
          if (!verified.ok) {
            return Response.json(
              { error: verified.reason, code: "INTERNAL_ASSERTION_INVALID" },
              { status: 401 }
            );
          }
          try {
            this.state.storage.transactionSync(() => {
              consumeNonceSync(
                this.sql,
                "internal_assertion_nonces",
                verified.claims.jti,
                verified.claims.aud,
                verified.claims.exp,
                Date.now()
              );
            });
          } catch (err) {
            if (err instanceof ControlAssuranceError) {
              return Response.json({ error: err.message, code: err.code }, { status: err.statusCode });
            }
            return Response.json(
              { error: "nonce_consume_failed", code: "NONCE_CONSUME_FAILED" },
              { status: 503 }
            );
          }
          boundIdentity = {
            actor: verified.claims.sub_actor,
            tenant: verified.claims.sub_tenant,
            method: "access",
            // Roles and clearance are resolved by Trust Fabric, never copied from the request.
            roles: ["authenticated"],
            clearance: "internal",
          };
          principalBinding = {
            ...(verified.claims.sub_agent ? { agent_id: verified.claims.sub_agent } : {}),
            ...(verified.claims.sub_credential ? { credential_id: verified.claims.sub_credential } : {}),
          };
        } else {
          // Explicit test-only path. Production never accepts unsigned request identities.
          if (this.env.SAFETY_INTERLOCK_TEST_MODE !== "true") {
            return Response.json(
              { error: "internal_assertion_secret_or_kid_missing", code: "INTERNAL_ASSERTION_CONFIG_MISSING" },
              { status: 503 }
            );
          }
          const candidate = body.identity;
          if (!candidate || typeof candidate.actor !== "string" || !candidate.actor.trim() ||
              typeof candidate.tenant !== "string" || !candidate.tenant.trim() ||
              candidate.method === "public" || !Array.isArray(candidate.roles) ||
              !candidate.roles.every((role) => typeof role === "string") ||
              !["public", "internal", "confidential", "secret"].includes(candidate.clearance)) {
            return Response.json(
              { error: "verified_non_public_identity_required", code: "IDENTITY_REQUIRED" },
              { status: 403 }
            );
          }
          boundIdentity = candidate;
        }

        const result = await this.evaluateAndGate(body.action, boundIdentity, principalBinding);
        return Response.json(result);
      }

      if ((path === "/approve" || path === "/decide") && request.method === "POST") {
        const body = await request.json().catch(() => null) as {
          approval_id?: string;
          approved?: boolean;
          operator?: string;
          identity?: Identity;
        } | null;
        if (!body || typeof body.approval_id !== "string" || typeof body.approved !== "boolean") {
          return Response.json({ error: "invalid_approval_decision", code: "INVALID_APPROVAL_DECISION" }, { status: 400 });
        }
        const result = await this.decideApproval(
          body.approval_id,
          body.approved,
          body.operator ?? "",
          body.identity
        );
        if ((result as { error?: string }).error) {
          const status = Number((result as { status?: number }).status) || 400;
          return Response.json(result, { status });
        }
        return Response.json(result);
      }

      if (path === "/pending" && request.method === "GET") {
        const rows = this.sql.exec(
          `SELECT id, action_json, policy_json, created_at, expires_at, status
           FROM pending_approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50`
        ).toArray() as Array<Record<string, SqlStorageValue>>;
        return Response.json({
          pending: rows.map((row) => ({
            id: String(row.id),
            action: JSON.parse(String(row.action_json)),
            policy: JSON.parse(String(row.policy_json)),
            created_at: Number(row.created_at),
            expires_at: Number(row.expires_at),
          })),
        });
      }

      if (path === "/log" && request.method === "GET") {
        const requested = Number.parseInt(url.searchParams.get("limit") ?? "30", 10);
        const limit = Number.isFinite(requested) ? Math.min(100, Math.max(1, requested)) : 30;
        const rows = this.sql.exec(
          `SELECT ts, action_tool, decision, risk, score, actor, detail
           FROM execution_log ORDER BY id DESC LIMIT ?`,
          limit
        ).toArray();
        return Response.json({ entries: rows });
      }

      if (path === "/audit/verify" && request.method === "GET") {
        const tenant = url.searchParams.get("tenant") ?? "";
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenant)) {
          return Response.json({ error: "invalid_tenant" }, { status: 400 });
        }
        const rows = this.sql.exec(
          "SELECT record_json, previous_hash, event_hash FROM audit_events WHERE tenant = ? ORDER BY id ASC",
          tenant
        ).toArray() as Array<{ record_json: string; previous_hash: string; event_hash: string }>;
        const intact = await verifyAuditChain(rows.map((row) => ({
          record: row.record_json,
          previousHash: row.previous_hash,
          hash: row.event_hash,
        })));
        return Response.json({ tenant, intact, events: rows.length });
      }

      if ((path === "/sandbox" || path === "/sandbox/exec") && request.method === "POST") {
        const body = (await request.json()) as {
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
      if (err instanceof ControlAssuranceError) {
        return Response.json({ ok: false, error: err.message, code: err.code }, { status: err.statusCode });
      }
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: "internal", message }, { status: 500 });
    }
  }

  private async evaluateAndGate(
    action: ProposedAction,
    identity: Identity,
    principalBinding: { agent_id?: string; credential_id?: string } = {}
  ): Promise<{
    status: "allowed" | "denied" | "pending_approval";
    policy?: PolicyResult;
    approval_id?: string;
    reasons?: string[];
    attestation?: AttestationEnvelope;
  }> {
    if (!this.env.TRUST) {
      throw new ControlAssuranceError(503, "TRUST_BINDING_MISSING", "TRUST Durable Object binding is unavailable.");
    }

    // Trust authorization is deliberately the first external gate: no log, audit or approval
    // write is permitted until the tenant-scoped Trust Fabric has answered.
    let trustDecision: { ok?: boolean; effect?: string; effective_roles?: string[]; reason?: string };
    try {
      const trustId = this.env.TRUST.idFromName(identity.tenant);
      const trustStub = this.env.TRUST.get(trustId);
      const trustResponse = await trustStub.fetch(new Request("https://trust.internal/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenant: identity.tenant,
          actor: identity.actor,
          tool: action.tool,
          roles: identity.roles,
          clearance: identity.clearance,
        }),
      }));
      if (!trustResponse.ok) {
        throw new Error("trust_authorization_http_" + trustResponse.status);
      }
      trustDecision = await trustResponse.json() as typeof trustDecision;
      if (trustDecision.ok !== true ||
          !["allow", "deny", "require_approval"].includes(String(trustDecision.effect))) {
        throw new Error("trust_authorization_invalid_response");
      }
    } catch {
      throw new ControlAssuranceError(503, "TRUST_AUTHORIZATION_UNAVAILABLE", "Trust Fabric authorization failed; evaluation is closed.");
    }

    const effectiveIdentity: Identity = {
      ...identity,
      roles: Array.isArray(trustDecision.effective_roles)
        ? trustDecision.effective_roles.filter((role): role is string => typeof role === "string")
        : identity.roles,
    };
    let policy = evaluatePolicy(action, effectiveIdentity);
    if (trustDecision.effect === "deny") {
      policy = {
        ...policy,
        decision: "deny",
        reasons: [...policy.reasons, trustDecision.reason || "Trust Fabric denied this action."],
      };
    } else if (trustDecision.effect === "require_approval" && policy.decision === "allow") {
      policy = {
        ...policy,
        decision: "require_approval",
        reasons: [...policy.reasons, trustDecision.reason || "Trust Fabric requires human approval."],
      };
    }

    let attestation: AttestationEnvelope | undefined;
    const hasAnyAttestationKey = Boolean(
      this.env.ATTESTATION_PRIVATE_KEY || this.env.ATTESTATION_PUBLIC_KEY || this.env.ATTESTATION_KEY_ID
    );
    if (hasAnyAttestationKey) {
      if (!this.env.ATTESTATION_PRIVATE_KEY || !this.env.ATTESTATION_PUBLIC_KEY || !this.env.ATTESTATION_KEY_ID) {
        throw new ControlAssuranceError(503, "ATTESTATION_KEYS_MISSING", "Attestation key configuration is incomplete.");
      }
      try {
        const encoded = this.env.ATTESTATION_PRIVATE_KEY;
        const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
        const privateBytes = Uint8Array.from(
          atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4)),
          (char) => char.charCodeAt(0)
        );
        const privateKey = await importEd25519PrivateKey(privateBytes);
        const decisionLabel = policy.decision === "allow"
          ? "ALLOW"
          : policy.decision === "deny" ? "DENY" : "REQUIRE_APPROVAL";
        attestation = await signAttestation({
          schema: "aston.safety.decision.v1",
          tenant: identity.tenant,
          actor: identity.actor,
          phase: "policy_evaluation",
          decision: decisionLabel,
          action,
          policy,
        }, privateKey, this.env.ATTESTATION_KEY_ID, "att_" + crypto.randomUUID());
      } catch {
        throw new ControlAssuranceError(503, "ATTESTATION_SIGN_FAILED", "Policy decision attestation could not be signed.");
      }
    }

    const now = Date.now();
    this.sql.exec(
      `INSERT INTO execution_log (ts, action_tool, decision, risk, score, actor, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      now,
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
      reasons: policy.reasons ?? [],
    });

    if (attestation) {
      const label = (attestation.payload as Record<string, unknown>).decision as string;
      this.sql.exec(
        "INSERT INTO decision_attestations (attestation_id, tenant, actor, decision, envelope_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        attestation.attestation_id,
        identity.tenant,
        identity.actor,
        label,
        JSON.stringify(attestation),
        now
      );
    }

    if (policy.decision === "deny") {
      return { status: "denied", policy, reasons: policy.reasons, ...(attestation ? { attestation } : {}) };
    }

    if (policy.decision === "require_approval") {
      const approvalId = crypto.randomUUID();
      const expiresAt = now + (policy.expires_in_ms ?? 30 * 60 * 1000);
      this.sql.exec(
        `INSERT INTO pending_approvals
         (id, action_json, identity_json, policy_json, created_at, expires_at, status, agent_id, credential_id)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        approvalId,
        JSON.stringify(action),
        JSON.stringify(identity),
        JSON.stringify(policy),
        now,
        expiresAt,
        principalBinding.agent_id ?? null,
        principalBinding.credential_id ?? null
      );
      return {
        status: "pending_approval",
        policy,
        approval_id: approvalId,
        ...(attestation ? { attestation } : {}),
      };
    }

    return { status: "allowed", policy, ...(attestation ? { attestation } : {}) };
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
    const previousHash = previous[0]?.event_hash ?? "GENESIS";
    const recordJson = JSON.stringify({ ts, tenant, actor, event_type: eventType, payload: record });
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
    operator: string,
    operatorIdentity?: Identity
  ): Promise<Record<string, unknown>> {
    const nowMs = Date.now();
    const decision = approved ? "approved" : "rejected";

    const rows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT id, identity_json, status, expires_at FROM pending_approvals WHERE id = ? LIMIT 1`,
        approvalId
      )
      .toArray();
    if (rows.length === 0) {
      return { error: "approval not found", status: 404, code: "APPROVAL_NOT_FOUND" };
    }
    const row = rows[0];
    if (String(row.status) === "EXPIRED_LEGACY_UNBOUND") {
      return { error: "legacy unbound approval expired", status: 410, code: "APPROVAL_LEGACY_UNBOUND" };
    }

    let tenantId = "unknown";
    try {
      const parsed = JSON.parse(String(row.identity_json ?? "{}"));
      if (typeof parsed?.tenant === "string" && parsed.tenant) tenantId = parsed.tenant;
    } catch {
      tenantId = "unknown";
    }
    if (!tenantId || tenantId === "unknown") {
      return { error: "approval missing tenant binding", status: 403, code: "TENANT_BINDING_MISSING" };
    }

    const actorId = operatorIdentity?.actor?.trim() ?? "";
    const roles = Array.isArray(operatorIdentity?.roles) ? operatorIdentity.roles : [];
    const method = operatorIdentity?.method ?? "public";
    if (!operatorIdentity || method === "public" || !actorId ||
        operatorIdentity.tenant !== tenantId ||
        !(roles.includes("approver") || roles.includes("admin")) ||
        (operator && operator.trim() && operator.trim() !== actorId)) {
      return { error: "verified same-tenant approver required", status: 403, code: "VERIFIED_APPROVER_REQUIRED" };
    }

    try {
      await assertCryptographicReadiness(this.env as any);
    } catch (err) {
      if (err instanceof ControlAssuranceError) {
        return { error: err.message, status: err.statusCode, code: err.code };
      }
      return { error: "attestation keys unavailable", status: 503, code: "ATTESTATION_KEYS_MISSING" };
    }

    let lease;
    try {
      lease = await claimOrRecoverLease({
        storage: this.state.storage as any,
        sql: this.sql,
        approvalId,
        tenantId,
        actorId,
        nowMs,
      });
    } catch (err) {
      if (err instanceof ControlAssuranceError) {
        return { error: err.message, status: err.statusCode, code: err.code };
      }
      return { error: "lease claim failed", status: 503, code: "LEASE_CLAIM_FAILED" };
    }

    const privB64 = this.env.ATTESTATION_PRIVATE_KEY as string;
    const keyId = this.env.ATTESTATION_KEY_ID as string;
    let attestation: AttestationEnvelope;
    try {
      const priv = await importEd25519PrivateKey(
        Uint8Array.from(
          atob(
            privB64.replace(/-/g, "+").replace(/_/g, "/") +
              "=".repeat((4 - (privB64.length % 4)) % 4)
          ),
          (c) => c.charCodeAt(0)
        )
      );
      const actionRow = this.sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT action_json, policy_json FROM pending_approvals WHERE id = ? LIMIT 1`,
          approvalId
        )
        .toArray()[0];
      const action = actionRow ? JSON.parse(String(actionRow.action_json)) : { tool: "unknown" };
      const policy = actionRow ? JSON.parse(String(actionRow.policy_json)) : {};
      attestation = await signAttestation(
        {
          schema: "aston.safety.decision.v1",
          tenant: tenantId,
          actor: actorId,
          phase: "human_approval",
          decision: approved ? "ALLOW" : "DENY",
          action,
          policy,
          approval_id: approvalId,
        },
        priv,
        keyId,
        "att_" + crypto.randomUUID()
      );
    } catch {
      return { error: "failed to sign decision attestation", status: 503, code: "ATTESTATION_SIGN_FAILED" };
    }

    try {
      const result = await finalizeApprovalWithLease({
        storage: this.state.storage as any,
        sql: this.sql,
        env: this.env as any,
        approvalId,
        tenantId,
        operator: { actor: actorId, tenant: tenantId, roles, method },
        decision,
        nowMs: Date.now(),
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        attestation,
      });

      this.sql.exec(
        `INSERT INTO execution_log (ts, action_tool, decision, risk, score, actor, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        Date.now(),
        (attestation.payload as any)?.action?.tool ?? "approval",
        decision,
        "n/a",
        0,
        actorId,
        `Lease-finalized human decision by ${actorId}; attestation=${result.attestationId}`
      );

      await emitLineage(this.env, {
        tenant: tenantId,
        object_id: approvalId,
        transformation: `safety.human_${decision}`,
        pipeline_version: "v15.5",
        actor: actorId,
        metadata: { attestation_id: result.attestationId, lease_id: lease.leaseId },
      });

      return {
        status: decision,
        approval_id: approvalId,
        decided_by: actorId,
        attestation_id: result.attestationId,
        lease_id: lease.leaseId,
        fencing_token: lease.fencingToken,
        attestation,
      };
    } catch (err) {
      if (err instanceof ControlAssuranceError) {
        return { error: err.message, status: err.statusCode, code: err.code };
      }
      return { error: "finalization failed", status: 503, code: "FINALIZE_FAILED" };
    }
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

    return {
      status: "sandbox_ready",
      message:
        "SafetyInterlock listo. Active el binding de Containers en wrangler.toml para ejecución real de código no confiable.",
      policy: gate.policy,
      note: "Fail-closed: no se ejecuta código hasta que el sandbox esté configurado.",
    };
  }
}

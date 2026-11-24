import test from "node:test";
import assert from "node:assert/strict";
import { SafetyInterlock } from "../src/do/safety-interlock.ts";

type Row = Record<string, any>;

class FakeSqlStorage {
  pending = new Map<string, Row>();
  audit: Row[] = [];
  logs: Row[] = [];
  attestations: Row[] = [];
  columns = new Set(["id","action_json","identity_json","policy_json","created_at","expires_at","status","decided_by","decided_at"]);
  triggers = new Set<string>();
  tables = new Set<string>();

  exec<T extends Record<string, any>>(query: string, ...args: any[]) {
    const q = query.replace(/\s+/g, " ").trim();
    let rows: Row[] = [];
    let rowsWritten = 0;

    if (q.startsWith("CREATE TRIGGER")) {
      const match = q.match(/TRIGGER IF NOT EXISTS ([a-zA-Z0-9_]+)/);
      if (match) this.triggers.add(match[1]);
    } else if (/^CREATE TABLE|^CREATE INDEX/i.test(q)) {
      const table = q.match(/^CREATE TABLE IF NOT EXISTS ([a-z_]+)/i)?.[1];
      if (table) this.tables.add(table);
      rows = [];
    } else if (q.startsWith("SELECT COUNT(*) AS cnt FROM sqlite_master")) {
      rows = [{ cnt: this.tables.has(String(args[0])) ? 1 : 0 }];
    } else if (q.startsWith("SELECT status FROM tenants")) {
      rows = [];
    } else if (q.startsWith("SELECT status FROM agents")) {
      rows = [];
    } else if (q.startsWith("SELECT status, expires_at, tenant_id, agent_id FROM agent_credentials")) {
      rows = [];
    } else if (q.startsWith("PRAGMA table_info(pending_approvals)")) {
      rows = [...this.columns].map((name) => ({ name }));
    } else if (q.startsWith("ALTER TABLE pending_approvals ADD COLUMN")) {
      const match = q.match(/ADD COLUMN ([a-z_]+)/i);
      if (match) {
        this.columns.add(match[1]);
        for (const row of this.pending.values()) {
          if (match[1] === "processing_attempt" || match[1] === "fencing_token") row[match[1]] = 0;
          else row[match[1]] = null;
        }
      }
    } else if (q.startsWith("SELECT id, identity_json FROM pending_approvals")) {
      rows = [...this.pending.values()]
        .filter((r) => ["pending", "processing"].includes(String(r.status)) &&
          (!r.agent_id || !r.credential_id))
        .map((r) => ({ id: r.id, identity_json: r.identity_json }));
    } else if (q.startsWith("UPDATE pending_approvals SET status = 'EXPIRED_LEGACY_UNBOUND'")) {
      const [migratedAt] = args;
      for (const row of this.pending.values()) {
        if (["pending", "processing"].includes(String(row.status)) && (!row.agent_id || !row.credential_id)) {
          Object.assign(row, { status: "EXPIRED_LEGACY_UNBOUND", lease_id: null, lease_expires_at: null,
            decided_at: row.decided_at ?? migratedAt });
        }
      }
      rowsWritten = 1;
    } else if (q.startsWith("SELECT event_hash FROM audit_events")) {
      const tenant = String(args[0]);
      const last = this.audit.filter((r) => r.tenant === tenant).at(-1);
      rows = last ? [{ event_hash: last.event_hash }] : [];
    } else if (q.startsWith("SELECT record_json, previous_hash, event_hash FROM audit_events")) {
      const tenant = String(args[0]);
      rows = this.audit.filter((r) => r.tenant === tenant).map((r) => ({ record_json: r.record_json, previous_hash: r.previous_hash, event_hash: r.event_hash }));
    } else if (q.startsWith("INSERT INTO audit_events")) {
      const [ts, tenant, actor, event_type, record_json, previous_hash, event_hash] = args;
      if (this.audit.some((r) => r.tenant === tenant && r.previous_hash === previous_hash)) throw new Error("audit_unique_conflict");
      this.audit.push({ ts, tenant, actor, event_type, record_json, previous_hash, event_hash });
      rowsWritten = 1;
    } else if (q.startsWith("INSERT INTO pending_approvals")) {
      const [id, action_json, identity_json, policy_json, created_at, expires_at] = args;
      const [agent_id, credential_id] = args.slice(6);
      this.pending.set(String(id), {
        id, action_json, identity_json, policy_json, created_at, expires_at, status: "pending",
        decided_by: null, decided_at: null, lease_id: null, lease_expires_at: null,
        processing_attempt: 0, fencing_token: 0, agent_id: agent_id ?? null, credential_id: credential_id ?? null,
      });
      rowsWritten = 1;
    } else if (q.startsWith("SELECT id, identity_json, status, expires_at FROM pending_approvals")) {
      const row = this.pending.get(String(args[0]));
      rows = row ? [{ id: row.id, identity_json: row.identity_json, status: row.status, expires_at: row.expires_at }] : [];
    } else if (q.startsWith("SELECT action_json, policy_json FROM pending_approvals")) {
      const row = this.pending.get(String(args[0]));
      rows = row ? [{ action_json: row.action_json, policy_json: row.policy_json }] : [];
    } else if (q.startsWith("SELECT id, identity_json, status, expires_at FROM pending_approvals")) {
      const row = this.pending.get(String(args[0]));
      rows = row ? [{ id: row.id, identity_json: row.identity_json, status: row.status, expires_at: row.expires_at }] : [];
    } else if (q.startsWith("SELECT action_json, policy_json FROM pending_approvals")) {
      const row = this.pending.get(String(args[0]));
      rows = row ? [{ action_json: row.action_json, policy_json: row.policy_json }] : [];
    } else if (q.startsWith("SELECT *, json_extract(identity_json") || q.startsWith("SELECT * FROM pending_approvals WHERE id = ?")) {
      const row = this.pending.get(String(args[0]));
      rows = row ? [{ ...row, tenant_id: JSON.parse(row.identity_json).tenant }] : [];
    } else if (q.startsWith("UPDATE pending_approvals SET status='processing'")) {
      const [leaseId, leaseExpiresAt, attempt, token, id, oldStatus, now, oldAttempt, oldToken, expectedStatus, recoverAt] = args;
      const row = this.pending.get(String(id));
      const eligible = row && (row.status === "pending" ||
        (row.status === "processing" && row.lease_expires_at !== null && row.lease_expires_at <= Number(recoverAt)));
      if (row && eligible && row.status === oldStatus && oldStatus === expectedStatus &&
          row.expires_at > Number(now) && Number(row.processing_attempt) === Number(oldAttempt) &&
          Number(row.fencing_token) === Number(oldToken)) {
        Object.assign(row, { status: "processing", lease_id: leaseId, lease_expires_at: leaseExpiresAt,
          processing_attempt: attempt, fencing_token: token });
        rowsWritten = 1;
      }
    } else if (q.startsWith("UPDATE pending_approvals SET status=?")) {
      const [status, actor, at, id, leaseId, token, leaseNow, approvalNow, tenant] = args;
      const row = this.pending.get(String(id));
      if (row && row.status === "processing" && row.lease_id === leaseId && row.fencing_token === token &&
          row.lease_expires_at > Number(leaseNow) && row.expires_at > Number(approvalNow) &&
          JSON.parse(row.identity_json).tenant === tenant) {
        Object.assign(row, { status, decided_by: actor, decided_at: at, lease_id: null, lease_expires_at: null });
        rowsWritten = 1;
      }
    } else if (q.startsWith("INSERT INTO decision_attestations")) {
      this.attestations.push({ attestation_id: args[0], tenant: args[1], actor: args[2], decision: args[3], envelope_json: args[4], created_at: args[5] });
      rowsWritten = 1;
    } else if (q.startsWith("INSERT INTO execution_log")) {
      const [ts, action_tool, decision, risk, score, actor, detail] = args;
      this.logs.push({ ts, action_tool, decision, risk, score, actor, detail });
      rowsWritten = 1;
    } else if (q.startsWith("SELECT id, action_json, policy_json, created_at, expires_at, status FROM pending_approvals")) {
      rows = [...this.pending.values()].filter((r) => r.status === "pending").slice(-50).reverse();
    } else if (q.startsWith("SELECT ts, action_tool, decision, risk, score, actor, detail FROM execution_log")) {
      const limit = Number(args[0] ?? 30);
      rows = this.logs.slice(-limit).reverse();
    } else {
      throw new Error("Unexpected SQL in SafetyInterlock test harness: " + q);
    }
    return { rowsWritten, toArray: () => rows as T[] };
  }
}

async function createInterlock(trustFetch: () => Promise<Response> = async () => Response.json({ ok: true, effect: "allow", reason: "test_role_grant" })) {
  const sql = new FakeSqlStorage();
  const state = {
    storage: {
      sql,
      transactionSync<T>(closure: () => T): T {
        const pendingBefore = new Map([...sql.pending].map(([k, v]) => [k, { ...v }]));
        const auditBefore = sql.audit.map((v) => ({ ...v }));
        const attestationsBefore = sql.attestations.map((v) => ({ ...v }));
        const logsBefore = sql.logs.map((v) => ({ ...v }));
        try { return closure(); }
        catch (error) {
          sql.pending.clear(); for (const [k, v] of pendingBefore) sql.pending.set(k, v);
          sql.audit.splice(0, sql.audit.length, ...auditBefore);
          sql.attestations.splice(0, sql.attestations.length, ...attestationsBefore);
          sql.logs.splice(0, sql.logs.length, ...logsBefore);
          throw error;
        }
      },
      async getAlarm() { return null; },
      async setAlarm(_when: number) {},
    },
  } as any;
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/[+]/g, "-").replace(/[/]/g, "_");
  const privateKey = encode(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
  const publicKey = encode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const trust = { idFromName() { return {}; }, get() { return { fetch: trustFetch }; } };
  const env = { TRUST: trust, ATTESTATION_PRIVATE_KEY: privateKey, ATTESTATION_PUBLIC_KEY: publicKey, ATTESTATION_KEY_ID: "test-key-1", SAFETY_INTERLOCK_TEST_MODE: "true" };
  return { interlock: new SafetyInterlock(state, env as any), sql };
}

const identity = {
  actor: "agent-actor-01",
  method: "access",
  tenant: "tenant-alpha",
  roles: ["executor"],
  clearance: "internal",
} as const;

test("AST-013C-DO-001 / actual SafetyInterlock class gates high-impact defense mitigation and records approval", async () => {
  const { interlock, sql } = await createInterlock();
  const evaluate = await interlock.fetch(new Request("https://safety.internal/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: { tool: "defense_mitigate", args: { mode: "block_ip", ip: "192.0.2.10" } },
      identity,
    }),
  }));
  assert.equal(evaluate.status, 200);
  const gate = await evaluate.json<any>();
  assert.equal(gate.status, "pending_approval");
  assert.equal(gate.policy.decision, "require_approval");
  assert.ok(gate.approval_id);
  assert.equal(gate.attestation.payload.decision, "REQUIRE_APPROVAL");
  assert.equal(gate.attestation.transparency.anchor_status, "not_submitted");

  const pendingResponse = await interlock.fetch(new Request("https://safety.internal/pending"));
  const pending = await pendingResponse.json<any>();
  assert.equal(pending.pending.length, 1);
  assert.equal(pending.pending[0].id, gate.approval_id);

  const operator = "verified-human-operator-09";
  const forgedDecision = await interlock.fetch(new Request("https://safety.internal/decide", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ approval_id: gate.approval_id, approved: true, operator }),
  }));
  assert.equal(forgedDecision.status, 403);
  const decisionResponse = await interlock.fetch(new Request("https://safety.internal/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approval_id: gate.approval_id, approved: true, identity: { ...identity, actor: operator, roles: ["approver"] } }),
  }));
  const decision = await decisionResponse.json<any>();
  assert.equal(decision.status, "approved");
  assert.equal(decision.decided_by, operator);
  assert.equal(decision.attestation.payload.decision, "ALLOW");

  const replayResponse = await interlock.fetch(new Request("https://safety.internal/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approval_id: gate.approval_id, approved: true, identity: { ...identity, actor: operator, roles: ["approver"] } }),
  }));
  const replay = await replayResponse.json<any>();
  assert.equal(replay.code, "APPROVAL_LEASE_HELD_OR_CONSUMED");
  assert.equal(replay.status, 409);

  const logResponse = await interlock.fetch(new Request("https://safety.internal/log?limit=10"));
  const log = await logResponse.json<any>();
  assert.ok(log.entries.some((entry: Row) => entry.actor === operator && entry.decision === "approved"));
  assert.equal(sql.pending.get(gate.approval_id)?.status, "approved");

  const auditResponse = await interlock.fetch(new Request("https://safety.internal/audit/verify?tenant=tenant-alpha"));
  const audit = await auditResponse.json<any>();
  assert.equal(audit.intact, true);
  assert.equal(audit.events, 3);
});

test("AST-013C-DO-002 / actual SafetyInterlock class denies critical action without secret clearance", async () => {
  const { interlock, sql } = await createInterlock();
  const response = await interlock.fetch(new Request("https://safety.internal/evaluate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: { tool: "disable_pool", args: { pool: "pool-alpha" } },
      identity,
    }),
  }));
  assert.equal(response.status, 200);
  const result = await response.json<any>();
  assert.equal(result.status, "denied");
  assert.equal(result.policy.decision, "deny");
  assert.equal(sql.pending.size, 0);
});

test("AST-CA-003 / Trust Fabric Durable Object outage returns 503 and creates no approval or execution log", async () => {
  const { interlock, sql } = await createInterlock(async () => { throw new Error("simulated_trust_do_timeout"); });
  const response = await interlock.fetch(new Request("https://safety.internal/evaluate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: { tool: "defense_mitigate", args: { mode: "block_ip", ip: "192.0.2.99" } },
      identity,
    }),
  }));
  assert.equal(response.status, 503);
  const result = await response.json<any>();
  assert.equal(result.ok, false);
  assert.equal(sql.pending.size, 0);
  assert.equal(sql.logs.length, 0);
});

test("AST-LEASE-MIGRATION: adds lease columns idempotently and preserves existing approval and audit triggers", async () => {
  const sql = new FakeSqlStorage();
  const legacy = {
    id: "legacy-approval", action_json: "{}", identity_json: JSON.stringify({ tenant: "tenant-alpha" }),
    policy_json: "{}", created_at: 10, expires_at: 90000, status: "pending",
    decided_by: null, decided_at: null,
  };
  sql.pending.set(legacy.id, { ...legacy });
  const state: any = { storage: {
    sql,
    transactionSync<T>(closure: () => T): T { return closure(); },
    async getAlarm() { return null; }, async setAlarm(_when: number) {},
  } };
  new SafetyInterlock(state, {} as any);
  const firstTriggerSet = [...sql.triggers].sort();
  new SafetyInterlock(state, {} as any);
  for (const column of ["lease_id", "lease_expires_at", "processing_attempt", "fencing_token"]) {
    assert.ok(sql.columns.has(column), `missing migrated column: ${column}`);
  }
  assert.deepEqual([...sql.triggers].sort(), firstTriggerSet);
  assert.equal(sql.pending.get(legacy.id)?.status, "EXPIRED_LEGACY_UNBOUND");
  assert.equal(sql.pending.get(legacy.id)?.processing_attempt, 0);
  assert.equal(sql.pending.get(legacy.id)?.fencing_token, 0);
  assert.equal(sql.pending.get(legacy.id)?.identity_json, legacy.identity_json);
});

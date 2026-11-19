import test from "node:test";
import assert from "node:assert/strict";
import { SafetyInterlock } from "../src/do/safety-interlock.ts";

type Row = Record<string, any>;

class FakeSqlStorage {
  pending = new Map<string, Row>();
  audit: Row[] = [];
  logs: Row[] = [];

  exec(query: string, ...args: any[]) {
    const q = query.replace(/\s+/g, " ").trim();
    let rows: Row[] = [];

    if (/^CREATE TABLE|^CREATE TRIGGER/i.test(q)) {
      rows = [];
    } else if (q.startsWith("SELECT event_hash FROM audit_events")) {
      const tenant = String(args[0]);
      const last = this.audit.filter((r) => r.tenant === tenant).at(-1);
      rows = last ? [{ event_hash: last.event_hash }] : [];
    } else if (q.startsWith("SELECT record_json, previous_hash, event_hash FROM audit_events")) {
      const tenant = String(args[0]);
      rows = this.audit.filter((r) => r.tenant === tenant).map((r) => ({ record_json: r.record_json, previous_hash: r.previous_hash, event_hash: r.event_hash }));
    } else if (q.startsWith("INSERT INTO audit_events")) {
      const [ts, tenant, actor, event_type, record_json, previous_hash, event_hash] = args;
      this.audit.push({ ts, tenant, actor, event_type, record_json, previous_hash, event_hash });
    } else if (q.startsWith("INSERT INTO pending_approvals")) {
      const [id, action_json, identity_json, policy_json, created_at, expires_at, status] = args;
      this.pending.set(String(id), { id, action_json, identity_json, policy_json, created_at, expires_at, status });
    } else if (q.startsWith("SELECT * FROM pending_approvals WHERE id = ?")) {
      const row = this.pending.get(String(args[0]));
      rows = row ? [{ ...row }] : [];
    } else if (q.startsWith("UPDATE pending_approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?")) {
      const [status, decided_by, decided_at, id] = args;
      const row = this.pending.get(String(id));
      if (row) Object.assign(row, { status, decided_by, decided_at });
    } else if (q.startsWith("UPDATE pending_approvals SET status = 'expired' WHERE id = ?")) {
      const row = this.pending.get(String(args[0]));
      if (row) row.status = "expired";
    } else if (q.startsWith("INSERT INTO execution_log")) {
      const [ts, action_tool, decision, risk, score, actor, detail] = args;
      this.logs.push({ ts, action_tool, decision, risk, score, actor, detail });
    } else if (q.startsWith("SELECT id, action_json, policy_json, created_at, expires_at, status FROM pending_approvals")) {
      rows = [...this.pending.values()].filter((r) => r.status === "pending").slice(-50).reverse();
    } else if (q.startsWith("SELECT ts, action_tool, decision, risk, score, actor, detail FROM execution_log")) {
      const limit = Number(args[0] ?? 30);
      rows = this.logs.slice(-limit).reverse();
    } else {
      throw new Error("Unexpected SQL in SafetyInterlock test harness: " + q);
    }

    return { toArray: () => rows };
  }
}

function createInterlock() {
  const sql = new FakeSqlStorage();
  const state = {
    storage: {
      sql,
      async getAlarm() { return null; },
      async setAlarm(_when: number) {},
    },
  } as any;
  return { interlock: new SafetyInterlock(state, {} as any), sql };
}

const identity = {
  actor: "agent-actor-01",
  method: "access",
  tenant: "tenant-alpha",
  roles: ["executor"],
  clearance: "internal",
} as const;

test("AST-013C-DO-001 / actual SafetyInterlock class gates high-impact defense mitigation and records approval", async () => {
  const { interlock, sql } = createInterlock();
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

  const pendingResponse = await interlock.fetch(new Request("https://safety.internal/pending"));
  const pending = await pendingResponse.json<any>();
  assert.equal(pending.pending.length, 1);
  assert.equal(pending.pending[0].id, gate.approval_id);

  const operator = "verified-human-operator-09";
  const decisionResponse = await interlock.fetch(new Request("https://safety.internal/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approval_id: gate.approval_id, approved: true, operator }),
  }));
  const decision = await decisionResponse.json<any>();
  assert.equal(decision.status, "approved");
  assert.equal(decision.decided_by, operator);

  const replayResponse = await interlock.fetch(new Request("https://safety.internal/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approval_id: gate.approval_id, approved: true, operator }),
  }));
  const replay = await replayResponse.json<any>();
  assert.equal(replay.error, "already approved");
  assert.equal(replay.status, 409);

  const logResponse = await interlock.fetch(new Request("https://safety.internal/log?limit=10"));
  const log = await logResponse.json<any>();
  assert.ok(log.entries.some((entry: Row) => entry.actor === operator && entry.decision === "approved"));
  assert.equal(sql.pending.get(gate.approval_id)?.status, "approved");

  const auditResponse = await interlock.fetch(new Request("https://safety.internal/audit/verify?tenant=tenant-alpha"));
  const audit = await auditResponse.json<any>();
  assert.equal(audit.intact, true);
  assert.equal(audit.events, 2);
});

test("AST-013C-DO-002 / actual SafetyInterlock class denies critical action without secret clearance", async () => {
  const { interlock, sql } = createInterlock();
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

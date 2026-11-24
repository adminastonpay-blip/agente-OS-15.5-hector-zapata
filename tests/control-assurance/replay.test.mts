import test from "node:test";
import assert from "node:assert/strict";
import { consumeApprovalAtomic, ControlAssuranceError, type PendingApproval } from "../../src/core/control-assurance.ts";

function createSql() {
  const approvals = new Map<string, PendingApproval>();
  const audit: Array<{ tenant: string; actor: string; eventType: string; payload: Record<string, unknown> }> = [];
  const sql = {
    approvals, audit,
    exec<T>(query: string, ...args: unknown[]) {
      const normalized = query.replace(/\s+/g, " ").trim();
      let rows: T[] = [];
      let rowsWritten = 0;
      if (normalized.startsWith("SELECT * FROM pending_approvals")) {
        const row = approvals.get(String(args[0]));
        rows = row ? [{ ...row } as T] : [];
      } else if (normalized.startsWith("UPDATE pending_approvals SET status = 'expired'")) {
        const row = approvals.get(String(args[0]));
        if (row?.status === "pending") { row.status = "expired"; rowsWritten = 1; }
      } else if (normalized.startsWith("UPDATE pending_approvals SET status = 'processing'")) {
        const row = approvals.get(String(args[0]));
        if (row?.status === "pending" && row.expires_at > Number(args[1])) { row.status = "processing"; rowsWritten = 1; }
      } else if (normalized.startsWith("UPDATE pending_approvals SET status = ?")) {
        const [status, actor, at, id] = args as [PendingApproval["status"], string, number, string];
        const row = approvals.get(id);
        if (row?.status === "processing") {
          Object.assign(row, { status, decided_by: actor, decided_at: at });
          rowsWritten = 1;
        }
      } else if (normalized.startsWith("UPDATE pending_approvals SET status = 'pending'")) {
        const row = approvals.get(String(args[0]));
        if (row?.status === "processing") { row.status = "pending"; rowsWritten = 1; }
      } else {
        throw new Error("Unsupported SQL: " + normalized);
      }
      return { rowsWritten, toArray: () => rows };
    },
  };
  return sql;
}

const seed = (): PendingApproval => ({
  id: "apr-001", action_json: JSON.stringify({ tool: "transfer" }),
  identity_json: JSON.stringify({ tenant: "tenant-alpha", actor: "agent-1" }),
  policy_json: "{}", created_at: 1000, expires_at: 10000, status: "pending",
});

test("AST-CA-001: first resolution succeeds; replay is 409, audited, and cannot re-sign or mutate original decision", async () => {
  const db = createSql();
  db.approvals.set("apr-001", seed());
  let signCalls = 0;
  const audit = async (event: { tenant: string; actor: string; eventType: string; payload: Record<string, unknown> }) => { db.audit.push(event); };

  const first = await consumeApprovalAtomic(db as unknown as SqlStorage, {
    approvalId: "apr-001", tenantId: "tenant-alpha", operatorId: "human-1",
    decision: "approved", nowMs: 2000,
    signDecision: async () => { signCalls++; return "att-001"; }, appendAudit: audit,
  });
  assert.equal(first.record.status, "approved");
  assert.equal(first.attestationId, "att-001");

  await assert.rejects(consumeApprovalAtomic(db as unknown as SqlStorage, {
    approvalId: "apr-001", tenantId: "tenant-alpha", operatorId: "attacker",
    decision: "approved", nowMs: 3000,
    signDecision: async () => { signCalls++; return "att-replay"; }, appendAudit: audit,
  }), (error: unknown) => error instanceof ControlAssuranceError && error.statusCode === 409);

  assert.equal(signCalls, 1);
  assert.equal(db.approvals.get("apr-001")?.decided_by, "human-1");
  assert.equal(db.approvals.get("apr-001")?.decided_at, 2000);
  assert.equal(db.approvals.get("apr-001")?.status, "approved");
  assert.equal(db.audit.filter((event) => event.eventType === "approval.replay_rejected").length, 1);
});

test("AST-CA-001: expired approval returns 410, is atomically expired, audited, and never signed", async () => {
  const db = createSql();
  db.approvals.set("apr-001", seed());
  let signed = false;
  await assert.rejects(consumeApprovalAtomic(db as unknown as SqlStorage, {
    approvalId: "apr-001", tenantId: "tenant-alpha", operatorId: "human-1",
    decision: "approved", nowMs: 10000,
    signDecision: async () => { signed = true; return "never"; },
    appendAudit: async (event) => { db.audit.push(event); },
  }), (error: unknown) => error instanceof ControlAssuranceError && error.statusCode === 410);
  assert.equal(signed, false);
  assert.equal(db.approvals.get("apr-001")?.status, "expired");
  assert.equal(db.audit.filter((event) => event.eventType === "approval.expired_rejected").length, 1);
});

test("AST-CA-001: concurrent replay has one atomic claimant", async () => {
  const db = createSql();
  db.approvals.set("apr-001", seed());
  let release!: () => void;
  const signingGate = new Promise<void>((resolve) => { release = resolve; });
  let signed = 0;
  const common = {
    approvalId: "apr-001", tenantId: "tenant-alpha", decision: "approved" as const, nowMs: 2000,
    appendAudit: async (event: { tenant: string; actor: string; eventType: string; payload: Record<string, unknown> }) => { db.audit.push(event); },
  };
  const first = consumeApprovalAtomic(db as unknown as SqlStorage, {
    ...common, operatorId: "human-1",
    signDecision: async () => { signed++; await signingGate; return "att-001"; },
  });
  await Promise.resolve();
  await assert.rejects(consumeApprovalAtomic(db as unknown as SqlStorage, {
    ...common, operatorId: "human-2", signDecision: async () => { signed++; return "att-002"; },
  }), (error: unknown) => error instanceof ControlAssuranceError && error.statusCode === 409);
  release();
  await first;
  assert.equal(signed, 1);
  assert.equal(db.approvals.get("apr-001")?.decided_by, "human-1");
});

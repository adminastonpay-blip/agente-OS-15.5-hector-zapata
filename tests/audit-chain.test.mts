import test from "node:test";
import assert from "node:assert/strict";
import { hashAuditRecord, verifyAuditChain } from "../src/security/audit-chain.ts";

test("verifies an intact append-only audit hash chain", async () => {
  const first = JSON.stringify({ tenant: "tenant-a", actor: "operator-a", event: "agent.denied" });
  const firstHash = await hashAuditRecord("GENESIS", first);
  const second = JSON.stringify({ tenant: "tenant-a", actor: "operator-a", event: "approval.rejected" });
  const secondHash = await hashAuditRecord(firstHash, second);
  assert.equal(await verifyAuditChain([
    { previousHash: "GENESIS", record: first, hash: firstHash },
    { previousHash: firstHash, record: second, hash: secondHash },
  ]), true);
});

test("detects modified records and broken chain links", async () => {
  const record = JSON.stringify({ tenant: "tenant-a", event: "agent.allowed" });
  const hash = await hashAuditRecord("GENESIS", record);
  assert.equal(await verifyAuditChain([
    { previousHash: "GENESIS", record: record + " ", hash },
  ]), false);
  assert.equal(await verifyAuditChain([
    { previousHash: "wrong-parent", record, hash },
  ]), false);
});

test("separates tenant chains through their record content", async () => {
  const a = JSON.stringify({ tenant: "tenant-a", event: "read" });
  const b = JSON.stringify({ tenant: "tenant-b", event: "read" });
  assert.notEqual(await hashAuditRecord("GENESIS", a), await hashAuditRecord("GENESIS", b));
});

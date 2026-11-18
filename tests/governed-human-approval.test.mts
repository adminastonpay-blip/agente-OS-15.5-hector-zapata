import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isVerifiedHumanApprover } from "../src/agents/governed.ts";

test("only a verified Access identity with the dedicated approver role can approve", () => {
  const base = {
    actor: "person@example.test",
    tenant: "tenant-fixture",
    roles: ["agent_approver"],
    clearance: "confidential" as const,
  };
  assert.equal(isVerifiedHumanApprover({ ...base, method: "access" }), true);
  assert.equal(isVerifiedHumanApprover({ ...base, method: "apikey" }), false);
  assert.equal(isVerifiedHumanApprover({ ...base, method: "sensor" }), false);
  assert.equal(isVerifiedHumanApprover({ ...base, method: "public" }), false);
  assert.equal(isVerifiedHumanApprover({ ...base, method: "access", roles: ["admin"] }), false);
});

test("execution cannot infer human approval from the plan status alone", () => {
  const source = readFileSync(new URL("../src/agents/governed.ts", import.meta.url), "utf8");
  assert.match(source, /FROM agent_plan_approvals/);
  assert.match(source, /plan_digest/);
  assert.match(source, /consumed_at IS NULL/);
  assert.match(source, /expires_at > \?/);
  assert.match(source, /approved_plan_digest_mismatch/);
  assert.match(source, /human_approval_missing_or_expired/);
  assert.doesNotMatch(source, /const humanApproved = true; \/\/ status approved/);
});

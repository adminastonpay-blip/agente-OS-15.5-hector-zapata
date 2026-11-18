import test from "node:test";
import assert from "node:assert/strict";
import {
  createPlan,
  approvePlan,
  executePlan,
  hasAssignedTenant,
} from "../src/agents/governed.ts";

const unassignedAccessIdentity = {
  actor: "unassigned-user@example.test",
  method: "access" as const,
  tenant: "unassigned-actor-fingerprint",
  roles: ["executor", "agent_approver"],
  clearance: "confidential" as const,
};

const assignedAccessIdentity = {
  ...unassignedAccessIdentity,
  tenant: "tenant-company-a",
};

function noDatabaseEnvironment() {
  return {
    DB: {
      prepare() {
        throw new Error("database_must_not_be_touched");
      },
    },
  } as any;
}

test("tenant assignment rejects synthetic unassigned identities", () => {
  assert.equal(hasAssignedTenant(unassignedAccessIdentity), false);
  assert.equal(hasAssignedTenant(assignedAccessIdentity), true);
});

test("createPlan fails closed before database access for an unassigned tenant", async () => {
  await assert.rejects(
    createPlan(noDatabaseEnvironment(), unassignedAccessIdentity, {
      goal: "must not create",
      steps: [{ action: "read", object_type: "record" }],
    }),
    /^Error: tenant_assignment_required$/,
  );
});

test("approvePlan fails closed before database access for an unassigned tenant", async () => {
  await assert.rejects(
    approvePlan(noDatabaseEnvironment(), unassignedAccessIdentity, "plan-fixture", {
      approve: true,
      reason: "must not approve",
    }),
    /^Error: tenant_assignment_required$/,
  );
});

test("executePlan fails closed before database access for an unassigned tenant", async () => {
  await assert.rejects(
    executePlan(noDatabaseEnvironment(), unassignedAccessIdentity, "plan-fixture"),
    /^Error: tenant_assignment_required$/,
  );
});

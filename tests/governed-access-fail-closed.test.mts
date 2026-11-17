import test from "node:test";
import assert from "node:assert/strict";
import { createPlan, approvePlan, executePlan } from "../src/agents/governed.ts";

const identity = {
  actor: "fixture-executor",
  method: "access" as const,
  tenant: "tenant-fixture",
  roles: ["executor"],
  clearance: "internal" as const,
};

function environment(effect: "allow" | "deny" | "require_approval", action: "create" | "execute") {
  const writes: string[] = [];
  const policy = {
    id: "policy-fixture",
    tenant: identity.tenant,
    name: "fixture policy",
    role: "*",
    object_type: "agent_plan",
    action,
    purpose: "agent",
    clearance: "*",
    effect,
    priority: 100,
  };
  const plan = {
    id: "plan-fixture",
    tenant: identity.tenant,
    agent_id: "agent-fixture",
    status: "approved",
    budget_calls: 10,
    budget_cost: 100,
    used_calls: 0,
    used_cost: 0,
  };
  const DB = {
    prepare(sql: string) {
      const statement: any = {
        bind(..._values: unknown[]) { return statement; },
        async all() {
          if (sql.includes("FROM access_policies")) return { results: [policy] };
          if (sql.includes("FROM agent_actions")) return { results: [] };
          return { results: [] };
        },
        async first() {
          if (sql.includes("FROM agent_plans")) return plan;
          return null;
        },
        async run() {
          writes.push(sql.trim().split(/\\s+/).slice(0, 4).join(" "));
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
  return { env: { DB } as any, writes };
}

test("AUTHZ-REQAPP-002 / createPlan rejects require_approval instead of creating a plan", async () => {
  const { env, writes } = environment("require_approval", "create");
  await assert.rejects(
    createPlan(env, identity, {
      goal: "fixture goal",
      steps: [{ action: "read", object_type: "fixture" }],
    }),
    /access_not_allowed:require_approval/,
  );
  assert.equal(writes.some((sql) => sql.startsWith("INSERT INTO agent_plans")), false);
  assert.equal(writes.some((sql) => sql.startsWith("INSERT INTO agent_actions")), false);
});

test("AUTHZ-REQAPP-002 / approvePlan rejects require_approval before changing plan status", async () => {
  const { env, writes } = environment("require_approval", "execute");
  await assert.rejects(
    approvePlan(env, identity, "plan-fixture", { approve: true, reason: "fixture" }),
    /access_not_allowed:require_approval/,
  );
  assert.equal(writes.some((sql) => sql.startsWith("UPDATE agent_plans")), false);
});

test("AUTHZ-REQAPP-002 / executePlan rejects require_approval before entering execution", async () => {
  const { env, writes } = environment("require_approval", "execute");
  await assert.rejects(
    executePlan(env, identity, "plan-fixture"),
    /access_not_allowed:require_approval/,
  );
  assert.equal(writes.some((sql) => sql.startsWith("UPDATE agent_plans")), false);
});

test("AUTHZ-REQAPP-002 / explicit deny remains rejected", async () => {
  const { env } = environment("deny", "create");
  await assert.rejects(
    createPlan(env, identity, {
      goal: "fixture goal",
      steps: [{ action: "read", object_type: "fixture" }],
    }),
    /access_not_allowed:deny/,
  );
});

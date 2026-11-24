import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTrustAccess } from "../src/core/trust-fabric.ts";
import type { Identity } from "../src/types.ts";

const identity = (roles: string[]): Identity => ({
  actor: "actor-1", tenant: "tenant-a", method: "access", roles, clearance: "internal",
});

test("Trust Fabric defaults to deny when no role grants the requested tool", () => {
  const result = evaluateTrustAccess(identity(["guest"]), "delete_object");
  assert.equal(result.effect, "deny");
  assert.equal(result.reason, "trust_default_deny");
});

test("executor role is evaluated before risk policy and grants tool invocation", () => {
  const result = evaluateTrustAccess(identity(["executor"]), "defense_mitigate");
  assert.equal(result.effect, "allow");
});

test("reader role is restricted to read-style tools", () => {
  assert.equal(evaluateTrustAccess(identity(["reader"]), "get_customer").effect, "allow");
  assert.equal(evaluateTrustAccess(identity(["reader"]), "delete_customer").effect, "deny");
});

test("tenant policy can explicitly deny or require approval", () => {
  const deny = evaluateTrustAccess(identity(["admin"]), "delete_object", [], [
    { tool: "delete_object", effect: "deny", required_roles: [], enabled: true },
  ]);
  assert.equal(deny.effect, "deny");
  const approval = evaluateTrustAccess(identity(["executor"]), "deploy_change", [], [
    { tool: "*", effect: "require_approval", required_roles: ["executor"], enabled: true },
  ]);
  assert.equal(approval.effect, "require_approval");
});

test("tenant role grants extend only the tenant-scoped effective role set", () => {
  const result = evaluateTrustAccess(identity(["guest"]), "recovery_diagnosis", ["recovery_diagnosis"]);
  assert.equal(result.effect, "allow");
  assert.deepEqual(result.effective_roles, ["guest", "recovery_diagnosis"]);
});

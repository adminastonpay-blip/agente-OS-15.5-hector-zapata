import test from "node:test";
import assert from "node:assert/strict";
import { buildTenantVectorQueryOptions } from "../src/do/agent-node.ts";

test("AgentNode Vectorize retrieval binds namespace and metadata filter to verified tenant", () => {
  const options = buildTenantVectorQueryOptions({
    actor: "agent-a", method: "access", tenant: "tenant-alpha",
    roles: ["operator"], clearance: "internal",
  });
  assert.deepEqual(options, {
    topK: 3,
    returnMetadata: "all",
    namespace: "tenant-alpha",
    filter: { tenant: { $eq: "tenant-alpha" } },
  });
});

test("AgentNode rejects missing or oversized tenant scope before vector retrieval", () => {
  const identity = {
    actor: "agent-a", method: "access" as const, tenant: "",
    roles: ["operator"], clearance: "internal" as const,
  };
  assert.throws(() => buildTenantVectorQueryOptions(identity), /valid_authenticated_tenant_required/);
  assert.throws(() => buildTenantVectorQueryOptions({ ...identity, tenant: "x".repeat(65) }), /valid_authenticated_tenant_required/);
});

test("AgentNode clamps retrieval count", () => {
  const identity = {
    actor: "agent-a", method: "access" as const, tenant: "tenant-alpha",
    roles: ["operator"], clearance: "internal" as const,
  };
  assert.equal(buildTenantVectorQueryOptions(identity, 999).topK, 20);
  assert.equal(buildTenantVectorQueryOptions(identity, -1).topK, 1);
});

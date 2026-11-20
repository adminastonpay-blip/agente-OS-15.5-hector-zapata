/**
 * Minimal unit tests for ASTON Command tenant scope resolution.
 * Run with: node --experimental-vm-modules --test tests/command-scope.test.mts
 * (pure logic mirrored here so CI does not need D1/DO bindings)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

type Identity = {
  actor: string;
  method: "access" | "apikey" | "sensor" | "public";
  tenant: string;
  roles: string[];
  clearance: "public" | "internal" | "confidential" | "secret";
};

const TENANT_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function isGlobalOperator(identity: Identity): boolean {
  return (
    identity.method !== "public" &&
    (identity.roles.includes("admin") ||
      identity.roles.includes("executor") ||
      identity.roles.includes("command") ||
      identity.clearance === "secret")
  );
}

function resolveTenantScope(
  tenantQuery: string,
  identity: Identity
): { mode: "global" | "tenant"; tenant_id: string | null; error?: string } {
  const q = (tenantQuery || "").trim();
  if (q && !TENANT_RE.test(q)) {
    return { mode: "tenant", tenant_id: null, error: "invalid_tenant_id" };
  }
  if (isGlobalOperator(identity)) {
    if (q) return { mode: "tenant", tenant_id: q };
    return { mode: "global", tenant_id: null };
  }
  const pinned = identity.tenant && identity.tenant !== "public" ? identity.tenant : null;
  if (!pinned || !TENANT_RE.test(pinned)) {
    return { mode: "tenant", tenant_id: null, error: "tenant_required" };
  }
  if (q && q !== pinned) {
    return { mode: "tenant", tenant_id: null, error: "tenant_scope_forbidden" };
  }
  return { mode: "tenant", tenant_id: pinned };
}

describe("command tenant scope", () => {
  const admin: Identity = {
    actor: "ops@aston",
    method: "access",
    tenant: "platform",
    roles: ["admin"],
    clearance: "secret",
  };
  const tenantOp: Identity = {
    actor: "bank-alpha-ops",
    method: "apikey",
    tenant: "bank-alpha",
    roles: ["viewer"],
    clearance: "internal",
  };

  it("admin without tenant_id sees global", () => {
    const s = resolveTenantScope("", admin);
    assert.equal(s.mode, "global");
    assert.equal(s.tenant_id, null);
    assert.equal(s.error, undefined);
  });

  it("admin with tenant_id scopes to that tenant", () => {
    const s = resolveTenantScope("bank-alpha", admin);
    assert.equal(s.mode, "tenant");
    assert.equal(s.tenant_id, "bank-alpha");
  });

  it("tenant operator is pinned to identity.tenant", () => {
    const s = resolveTenantScope("", tenantOp);
    assert.equal(s.mode, "tenant");
    assert.equal(s.tenant_id, "bank-alpha");
  });

  it("tenant operator cannot query another tenant", () => {
    const s = resolveTenantScope("fintech-beta", tenantOp);
    assert.equal(s.error, "tenant_scope_forbidden");
  });

  it("rejects invalid tenant_id shape", () => {
    const s = resolveTenantScope("bad tenant!", admin);
    assert.equal(s.error, "invalid_tenant_id");
  });
});

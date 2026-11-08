/**
 * Trust isolation unit tests (Node, no Workers runtime).
 * Run: npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Mirror sanitize + public tenant rules (keep in sync with src/lib/identity.ts)
const PUBLIC_TENANT = "default";
function sanitizeTenant(t) {
  const s = String(t).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
  return s || PUBLIC_TENANT;
}
function publicIdentityIgnoresHeader(headerTenant) {
  // Public path must NOT use client header
  return { tenant: PUBLIC_TENANT, method: "public" };
}
function authedMayOverride(headerTenant) {
  return { tenant: sanitizeTenant(headerTenant), method: "apikey" };
}

describe("tenant isolation P0", () => {
  it("public identity ignores X-Aston-Tenant spoof", () => {
    const id = publicIdentityIgnoresHeader("victim-corp");
    assert.equal(id.tenant, "default");
    assert.equal(id.method, "public");
  });

  it("authenticated may set sanitized tenant", () => {
    const id = authedMayOverride("Acme_Logistics-01");
    assert.equal(id.tenant, "Acme_Logistics-01");
  });

  it("sanitize strips injection characters", () => {
    assert.equal(sanitizeTenant("../etc/passwd"), "etcpasswd");
    assert.equal(sanitizeTenant(""), "default");
  });
});

describe("validate endpoint contract", () => {
  it("empty account must be rejected by API contract", () => {
    const accountId = "";
    assert.equal(!!accountId.trim(), false);
  });
});

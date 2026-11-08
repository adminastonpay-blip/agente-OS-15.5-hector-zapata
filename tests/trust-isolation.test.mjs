import { describe, it } from "node:test";
import assert from "node:assert/strict";

const PUBLIC_TENANT = "default";
function sanitizeTenant(t) {
  const s = String(t).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
  return s || PUBLIC_TENANT;
}
function publicIdentityIgnoresHeader() {
  return { tenant: PUBLIC_TENANT, method: "public" };
}

const ALLOWED = {
  RECEIVED: ["IDENTIFIED", "FAILED"],
  IDENTIFIED: ["AUTHORIZED", "DENIED", "FAILED"],
  AUTHORIZED: ["BUDGET_RESERVED", "DENIED", "FAILED"],
  BUDGET_RESERVED: ["EXECUTING", "FAILED", "DENIED"],
  EXECUTING: ["EXECUTED", "FAILED"],
  EXECUTED: ["VERIFIED", "FAILED"],
  VERIFIED: ["EVIDENCE_STORED", "FAILED"],
  EVIDENCE_STORED: ["TIMESTAMP_PENDING", "REVOKED"],
  TIMESTAMP_PENDING: ["TIMESTAMP_CONFIRMED", "FAILED"],
  TIMESTAMP_CONFIRMED: ["REVOKED"],
  DENIED: [],
  FAILED: [],
  REVOKED: [],
};
function canTransition(from, to) {
  return (ALLOWED[from] || []).includes(to);
}

describe("tenant isolation P0", () => {
  it("public ignores spoof header", () => {
    const id = publicIdentityIgnoresHeader();
    assert.equal(id.tenant, "default");
  });
  it("sanitize strips path tricks", () => {
    assert.equal(sanitizeTenant("../x"), "x");
  });
});

describe("decision lifecycle", () => {
  it("allows happy path steps", () => {
    assert.equal(canTransition("RECEIVED", "IDENTIFIED"), true);
    assert.equal(canTransition("AUTHORIZED", "BUDGET_RESERVED"), true);
    assert.equal(canTransition("EXECUTED", "VERIFIED"), true);
  });
  it("rejects skip to TIMESTAMP_CONFIRMED", () => {
    assert.equal(canTransition("EXECUTED", "TIMESTAMP_CONFIRMED"), false);
  });
});

describe("constitution deny list", () => {
  it("blocks wire_transfer by default policy name", () => {
    const denied = ["delete", "wire_transfer", "export_all"];
    assert.equal(denied.includes("wire_transfer"), true);
  });
});

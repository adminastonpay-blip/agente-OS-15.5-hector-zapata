import test from "node:test";
import assert from "node:assert/strict";
import { createD1TenantIdentityAuthority } from "../src/tenant-identity-d1-authority.ts";

function fakeDb(row: Record<string, unknown> | null, error?: Error) {
  const calls: unknown[][] = [];
  return {
    calls,
    prepare(sql: string) {
      return { bind(...args: unknown[]) {
        return { async first<T>() {
          calls.push([sql, ...args]);
          if (error) throw error;
          return row as T | null;
        } };
      } };
    }
  };
}
const activeRow = {
  tenant_id: "tenant-a", auth_method: "access", membership_status: "active",
  capabilities_json: '["risk.read"]', audiences_json: '["aston-api"]',
  membership_not_before: 100, membership_expires_at: 900,
  tenant_status: "active", tenant_not_before: 50,
};

test("resolves Access identity by verified issuer and subject, never by tenant claim", async () => {
  const db = fakeDb(activeRow);
  const result = await createD1TenantIdentityAuthority(db as never).resolve({
    kind: "access", verified: true, issuer: "https://team.cloudflareaccess.com", subject: "sub-123"
  });
  assert.equal(result?.tenant.tenantId, "tenant-a");
  assert.deepEqual(result?.membership.capabilities, ["risk.read"]);
  assert.deepEqual(db.calls[0].slice(1), ["https://team.cloudflareaccess.com", "sub-123"]);
});

test("resolves API credential only by full SHA-256 credential identifier", async () => {
  const db = fakeDb({ ...activeRow, auth_method: "apikey" });
  await createD1TenantIdentityAuthority(db as never).resolve({
    kind: "api_key", verified: true, credentialId: `sha256:${"a".repeat(64)}`
  });
  assert.deepEqual(db.calls[0].slice(1), ["apikey", `sha256:${"a".repeat(64)}`]);
});

test("rejects malformed credential fingerprint before querying D1", async () => {
  const db = fakeDb(activeRow);
  const result = await createD1TenantIdentityAuthority(db as never).resolve({
    kind: "sensor", verified: true, credentialId: "sha256:short"
  });
  assert.equal(result, null);
  assert.equal(db.calls.length, 0);
});

test("rejects legacy, unassigned and malformed tenant IDs", async () => {
  for (const tenant_id of ["default", "ops", "unassigned-user", "Tenant-A", "bad tenant"]) {
    const db = fakeDb({ ...activeRow, tenant_id });
    assert.equal(await createD1TenantIdentityAuthority(db as never).resolve({
      kind: "access", verified: true, issuer: "https://team.cloudflareaccess.com", subject: "sub-123"
    }), null);
  }
});

test("rejects malformed capabilities or audiences JSON", async () => {
  const db = fakeDb({ ...activeRow, capabilities_json: '{"admin":true}' });
  assert.equal(await createD1TenantIdentityAuthority(db as never).resolve({
    kind: "access", verified: true, issuer: "https://team.cloudflareaccess.com", subject: "sub-123"
  }), null);
});

test("fails closed when D1 is unavailable", async () => {
  const db = fakeDb(null, new Error("D1 unavailable"));
  await assert.rejects(() => createD1TenantIdentityAuthority(db as never).resolve({
    kind: "access", verified: true, issuer: "https://team.cloudflareaccess.com", subject: "sub-123"
  }));
});

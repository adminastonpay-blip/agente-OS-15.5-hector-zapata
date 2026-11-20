import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/20261120_00_tenant_lifecycle.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/20261120_01_tenant_identity_registry.sql", import.meta.url), "utf8"));
  return db;
}
function lifecycle(db: DatabaseSync, tenantId: string, operation: "create" | "activate", occurredAt: number) {
  const status = operation === "create" ? "pending" : "active";
  db.prepare(`
    INSERT INTO aston_tenant_lifecycle_idempotency (
      actor_principal_id, idempotency_key, fingerprint, audit_event_id,
      tenant_id, operation, target_status, actor_scope, reason, correlation_id, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'platform', ?, NULL, ?)
  `).run(
    "bootstrap:platform", `${operation}-${tenantId}`, (operation === "create" ? "a" : "b").repeat(64),
    `audit-${operation}-${tenantId}`, tenantId, operation, status,
    `approved tenant ${operation}`, occurredAt,
  );
}
function binding(db: DatabaseSync, values: {
  id: string; tenant: string; method: "access" | "apikey" | "sensor";
  issuer?: string | null; subject?: string | null; credential?: string | null;
}) {
  db.prepare(`
    INSERT INTO aston_tenant_identity_bindings (
      binding_id, tenant_id, auth_method, issuer, subject, credential_id,
      status, capabilities_json, audiences_json, not_before, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, NULL, 1000, 1000)
  `).run(
    values.id, values.tenant, values.method, values.issuer ?? null, values.subject ?? null,
    values.credential ?? null, '["risk.read"]', '["aston-api"]',
  );
}

test("TEN-02 lifecycle triggers create and activate a tenant atomically", () => {
  const db = database();
  lifecycle(db, "tenant-a", "create", 1000);
  assert.equal(db.prepare("SELECT status FROM aston_tenants WHERE tenant_id = ?").get("tenant-a").status, "pending");
  lifecycle(db, "tenant-a", "activate", 2000);
  assert.equal(db.prepare("SELECT status FROM aston_tenants WHERE tenant_id = ?").get("tenant-a").status, "active");
  assert.equal(db.prepare("SELECT count(*) AS n FROM aston_tenant_lifecycle_audit WHERE tenant_id = ?").get("tenant-a").n, 2);
  db.close();
});

test("identity binding requires an active tenant", () => {
  const db = database();
  lifecycle(db, "tenant-pending", "create", 1000);
  assert.throws(() => binding(db, {
    id: "bind-pending", tenant: "tenant-pending", method: "access",
    issuer: "https://team.cloudflareaccess.com", subject: "subject-1",
  }), /IDENTITY_TENANT_NOT_ACTIVE/);
  db.close();
});

test("one credential fingerprint cannot be enrolled as both API key and sensor", () => {
  const db = database();
  lifecycle(db, "tenant-a", "create", 1000);
  lifecycle(db, "tenant-a", "activate", 2000);
  const credential = `sha256:${"c".repeat(64)}`;
  binding(db, { id: "bind-api", tenant: "tenant-a", method: "apikey", credential });
  assert.throws(() => binding(db, {
    id: "bind-sensor", tenant: "tenant-a", method: "sensor", credential,
  }), /UNIQUE constraint failed/);
  db.close();
});

test("Access bindings are unique by issuer and subject", () => {
  const db = database();
  lifecycle(db, "tenant-a", "create", 1000);
  lifecycle(db, "tenant-a", "activate", 2000);
  const principal = { issuer: "https://team.cloudflareaccess.com", subject: "subject-1" };
  binding(db, { id: "bind-access-1", tenant: "tenant-a", method: "access", ...principal });
  assert.throws(() => binding(db, {
    id: "bind-access-2", tenant: "tenant-a", method: "access", ...principal,
  }), /UNIQUE constraint failed/);
  db.close();
});

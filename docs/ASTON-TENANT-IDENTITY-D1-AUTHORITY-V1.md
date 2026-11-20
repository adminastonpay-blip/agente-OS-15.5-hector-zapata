# ASTON Tenant Identity D1 Authority v1

Status: IMPLEMENTED IN ISOLATED BRANCH / TESTS PENDING / NOT VALIDATED AGAINST LIVE D1.

## Purpose
Read-only authority provider that maps cryptographically verified Access issuer+subject or a full SHA-256 API/sensor credential fingerprint to an active tenant and explicit capabilities/audiences. The caller must pass the internal principal from `authenticateWithContext`; never pass request-body or header claims as proof.

## Data model
- `aston_tenants`: lifecycle state, version and timestamps (TEN-02 lifecycle schema).
- `aston_tenant_identity_bindings`: one active binding per Access issuer+subject or API/sensor credential fingerprint, with explicit capabilities, audiences, validity and status.
- `default`, `ops`, and `unassigned-*` are rejected as authoritative tenant IDs.

## Safety
- Provider is read-only; it cannot enroll, activate, revoke or change bindings.
- Missing binding, malformed JSON, invalid principal, legacy tenant, or D1 error never grants authority.
- It does not change route behavior and is not wired into request execution.
- API key and sensor currently share one secret. The schema enforces one unique credential fingerprint across both classes, so the shared secret cannot be enrolled as both API and sensor identities. A distinct sensor secret is required before independently authorizing the sensor.
- No existing identity receives authority until an administrator provisions a binding through a separately authenticated control-plane workflow.
- The proposed migrations are not applied to Preview or Production D1.

## Files
- `src/tenant-identity-d1-authority.ts`
- `migrations/20261120_00_tenant_lifecycle.sql`
- `migrations/20261120_01_tenant_identity_registry.sql`
- `tests/tenant-identity-d1-authority.test.mts`

## Validation
Tests use a deterministic D1 test double. This is not a live Cloudflare D1 integration test. The migration must be applied only to an isolated disposable SQLite/D1 staging database after migration ordering is reconciled.

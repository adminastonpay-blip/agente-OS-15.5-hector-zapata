# TEN-02 — Authoritative Tenant Lifecycle Design

**Status:** DESIGN PROPOSED — NOT IMPLEMENTED  
**Scope:** GitHub-only architecture work. No Cloudflare bindings, deployment, D1 migration, secrets, or production changes.  
**Baseline:** `main` at the start of this work (branch created directly from current `main`).

## 1. Security objective

A cryptographically valid credential MUST NOT authorize any operation when its tenant is suspended, revoked, archived, unknown, or cannot be authoritatively checked.

JWT signature validity proves that an issuer signed claims. It does not prove that the tenant remains entitled to use the system. Tenant lifecycle authorization is a separate, mandatory decision.

## 2. Repository findings (current implementation)

The current `src/auth.ts` verifies Cloudflare Access JWT signature, issuer, audience, and time claims, then derives `Identity.tenant` from `p.custom.tenant`. It does not consult a tenant lifecycle registry.

If the tenant claim is absent or malformed, `resolveTenantClaim` creates an `unassigned-<fingerprint>` tenant. This isolates identities, but does not establish that the tenant is registered or active.

The API-key path currently assigns the literal tenant `default`; the sensor path assigns `ops`. Neither path checks tenant lifecycle state.

The current `schema.sql` contains tenant-scoped application tables but no authoritative tenant registry, lifecycle version, revocation record, or tenant provisioning authority. No existing tenant provisioning/source-of-truth contract was identified in the inspected runtime files.

**Conclusion:** TEN-02 cannot safely be closed by adding a speculative table or treating a JWT claim as its own authority. The authoritative issuer/provisioning owner and the credential-to-tenant binding must be defined first.

## 3. Required authoritative model

Introduce a tenant registry only after its owner and provisioning workflow are approved. Minimum logical record:

| Field | Requirement |
|---|---|
| tenant_id | Immutable canonical identifier; unique |
| status | `provisioning`, `active`, `suspended`, `revoked`, `archived` |
| lifecycle_version | Monotonically increasing integer |
| created_at / updated_at | Authoritative timestamps |
| status_changed_at | Timestamp of most recent transition |
| status_reason_code | Controlled reason code; no secrets or unnecessary personal data |
| issuer_binding | Approved issuer/subject or credential binding reference |
| policy_version | Version of tenant policy applicable to authorization |

The registry is authoritative. JWT custom claims, request headers, API-key labels, cache entries, and caller-supplied tenant IDs are not authoritative lifecycle sources.

## 4. Mandatory authorization sequence

For every authenticated request:

1. Verify credential cryptography, issuer, audience, expiry, and not-before as applicable.
2. Resolve a canonical tenant ID from an approved issuer/credential binding. Never trust a caller-supplied tenant header.
3. Load the tenant lifecycle record from the authoritative registry.
4. If the registry is unavailable, malformed, ambiguous, or stale beyond the explicitly approved consistency bound: **DENY**.
5. Require status exactly `active`.
6. Bind the request identity to the registry's canonical tenant ID and lifecycle version.
7. Only then evaluate roles, policy, resource ownership, SafetyInterlock, and action-specific authorization.
8. Record a tamper-evident decision event with tenant ID, lifecycle version, credential/issuer reference, decision, reason code, correlation ID, and timestamp.

No protected read, model call, tool execution, write, queue enqueue, or delegated action may occur before steps 1–6 complete.

## 5. State-transition rules

Allowed transitions must be explicit and audited:

- `provisioning -> active`: only after required onboarding and ownership checks pass.
- `active -> suspended`: immediate deny; reversible only by an authorized reactivation workflow.
- `active -> revoked`: immediate deny; terminal for that tenant ID.
- `suspended -> active`: require a fresh approval and increment lifecycle_version.
- `suspended -> revoked`: terminal revocation.
- `revoked -> archived`: retention/records state only; remains denied.
- `archived`: terminal; no credential may reactivate the same tenant ID.

Never recycle tenant IDs. Re-onboarding must create a new tenant ID and a separately audited relationship to any prior tenant.

Every transition increments lifecycle_version. A credential issued against an older lifecycle version must not bypass a later suspension or revocation. If credentials cannot carry the version, the online registry check remains mandatory.

## 6. Credential-specific requirements

### Cloudflare Access JWT
- Continue validating signature, issuer, audience, exp, nbf, and key ID.
- Treat `custom.tenant` as a requested binding hint only until matched against the authoritative issuer/subject binding.
- Do not allow a signed JWT to create a tenant or change its status.
- Unknown/missing tenant binding => deny; do not silently create an operational tenant.

### API keys
- Replace the global implicit `default` tenant with an explicit server-side credential record bound to exactly one tenant, scopes, status, and key version.
- Store only a cryptographic hash/fingerprint of the secret; never store or log the raw key.
- Key revocation and tenant revocation are independent deny conditions.
- No fallback to a shared tenant when mapping is missing.

### Sensor credentials
- Give sensors explicit tenant and narrow scopes through the same credential registry.
- A shared API secret must not implicitly grant the `ops` tenant or privileged roles.

## 7. Consistency, caching, and fail-closed behavior

- Initial implementation should perform an authoritative lifecycle read for every authorization boundary.
- Any future cache requires a documented maximum staleness, invalidation protocol, and proof that revocation takes effect within the approved bound.
- Do not cache `active` indefinitely; do not use stale-positive cache results when the registry is unavailable.
- Registry errors, timeouts, missing rows, duplicate bindings, unknown statuses, and version rollback => deny.
- A local emergency override must not silently authorize tenants. If later required, it needs dual control, bounded expiry, immutable audit, and explicit scope.

## 8. Required adversarial and positive tests

Tests must exercise the real authentication/authorization boundary, not only a helper function.

| Scenario | Expected result |
|---|---|
| Valid signature + active tenant + correct issuer binding | Continue to policy evaluation |
| Valid signature + suspended tenant | Deny before protected operation |
| Valid signature + revoked tenant | Deny before protected operation |
| Valid signature + archived tenant | Deny permanently |
| Valid signature + unknown tenant | Deny |
| Missing/malformed tenant claim | Deny; no synthetic tenant provisioning |
| Valid tenant claim but issuer-subject binding mismatch | Deny |
| Registry unavailable / timeout / malformed response | Deny |
| Registry lifecycle version rolls back | Deny and emit security event |
| Old credential after suspension/revocation | Deny |
| API key with no explicit tenant mapping | Deny |
| Sensor key presented as general API key | Deny or least-privilege sensor-only path |
| Active tenant A attempts tenant B resource | Deny |
| Active tenant A performs permitted operation on A resource | Allow (positive control) |

For every denial, assert zero downstream side effects: no D1 write, no queue enqueue, no Durable Object action, no AI invocation, and no protected data in the response.

## 9. Implementation gates (must be satisfied before runtime code)

- [ ] Owner of tenant provisioning and authoritative registry identified.
- [ ] Source of truth selected and its availability/consistency guarantees documented.
- [ ] Existing tenant IDs inventoried and mapped by an authorized operator; no guessed mappings.
- [ ] Cloudflare Access issuer/subject-to-tenant binding contract approved.
- [ ] API-key and sensor credential migration plan approved.
- [ ] Fail-closed behavior and operational recovery procedure approved.
- [ ] Schema and migration reviewed with rollback/backup strategy.
- [ ] Real-route tests and positive controls pass in isolated test environment.
- [ ] Only after all above: separate PR for runtime enforcement and separately authorized staging integration.

## 10. Explicit non-goals / safety boundary

This design does not create a tenant registry, migrate tenant data, alter authentication behavior, deploy Workers, modify Cloudflare resources, or claim TEN-02 is fixed. It intentionally leaves runtime behavior unchanged until the authoritative provisioning source is known.

**Current verdict:** `TEN-02 = OPEN / NOT IMPLEMENTED / NOT VALIDATED`. The missing authority is a design blocker, not a test pass.

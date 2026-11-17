# ASTON OS — SafetyInterlock Fail-Closed Remediation

**Base:** `main` SHA `077331484f0cbfae4a23139564000117510a6767`  
**Branch:** `fix/safety-interlock-fail-closed-01`  
**Scope:** isolated source remediation and regression tests only.  
**Production / Cloudflare:** untouched.  
**Merge status:** not merged.

## Implemented in this branch — CI regression checks passed

1. `AgentNode.safetyCheck()` now requires the SafetyInterlock response contract version `1`.
2. Only the three documented decision statuses are accepted: `allowed`, `denied`, and `pending_approval`. A pending decision without an approval ID is rejected.
3. Interlock evaluation has an application-enforced 2,000 ms deadline. Timeout aborts the request and returns deny. A late response cannot change the already-settled decision.
4. Tool execution requires the exact status `allowed`; every other status is denied.
5. The real SafetyInterlock `/evaluate` endpoint now emits `contract_version: "1"`.
6. Secure ontology reads now release data only for an explicit `allow`; `require_approval` returns no records.
7. Ontology links now carry a tenant key; link creation verifies both endpoints belong to the caller tenant, and impact traversal filters by tenant.
8. Added a D1 migration. Legacy links receive an empty tenant and are intentionally not traversable until mapped to an authoritative tenant.
7. Added paired route-handler regression tests for sensitive-read approval block and operational-read allow.

## Regression matrix

| Scenario | Expected result | Execution |
|---|---|---|
| Missing Safety DO | Deny before planning/tool | Included |
| DO fetch throws | Deny, no tool invocation | Included |
| Response delayed beyond 2 seconds | Bounded deny; late allow ignored | Included |
| Unknown status | Deny, no tool invocation | Included |
| Empty 204 response | Deny, no tool invocation | Included |
| Explicit contract-v1 allow | Tool executes exactly once | Included |
| Contract version 99 | Deny, no tool invocation | Included |
| Sensitive read / require_approval | No protected records disclosed | Included |
| Operational read / allow | Legitimate operational data returned | Included |
| Cross-tenant nested link | Reject endpoint owned by another tenant; preserve same-tenant positive control | Included |
| Same external root ID across tenant partitions | Impact route returns only that tenant's links | Included |

## Still not implemented / not verified

The three tenant-boundary scenarios from the original plan remain open:

- **TEN-01:** link creation and impact traversal are now tenant-scoped and have route/function regression coverage. CI and migration execution remain pending.
- **TEN-02:** cryptographically valid token for a revoked/archived tenant remains NOT IMPLEMENTED. Authentication validates JWT cryptography/claims but no authoritative tenant lifecycle registry was identified. Adding a registry without a confirmed tenant provisioning and migration process could lock out existing tenants; this requires that source-of-truth decision.
- **TEN-03:** impact traversal now scopes by tenant and has a same-external-ID positive partition test. A full database-level same-primary-key collision is not possible under the current global `objects.id PRIMARY KEY` schema; that storage invariant is not a substitute for testing every resource route.

The D1 migration `migrations/20261117_tenant_scoped_links.sql` has NOT been applied to any database. Existing link rows receive tenant `''` and fail closed (they will no longer appear in tenant-scoped traversal) until an authorized owner maps them. Do not deploy this code before applying the migration and resolving legacy link ownership.

## Evidence rules

- CI status and individual test traces must be inspected before any case is marked passed.
- Synthetic Safety DO tests exercise the real AgentNode route but not the real Durable Object SQL/policy engine.
- The authorization read tests exercise the actual `handleAccess` route handler and secure-read function using a deterministic D1 fixture; they do not claim a live Cloudflare D1 deployment.
- No vulnerability is marked production-validated.

## CI evidence — 2026-11-17

**Final branch HEAD:** `dbfa447b6e7ed47e920ef86313f687e92f0add6a`

- [ASTON OS Audit Staging Validation](https://github.com/adminastonpay-blip/agente-OS-15.5-hector-zapata/actions/runs/44182492533): SUCCESS.
- [Cloudflare CI](https://github.com/adminastonpay-blip/agente-OS-15.5-hector-zapata/actions/runs/44182492665): SUCCESS. TypeScript check, security regression tests, production bundle dry-run and isolated staging bundle dry-run all succeeded.
- Security regression suite: 19 safety tests passed; 52 existing security tests passed; 12 new targeted authorization/interlock/tenant-link tests passed; 0 failures.
- Secret history scan: SUCCESS.
- Dependency vulnerability audit: SUCCESS.
- Cloudflare GitHub App preview checks: FAILURE because the configured Worker preview target reports that the Worker does not exist in the connected Cloudflare account. This is an integration/account-target failure, not a source test failure; no deployment was performed.

## Validation boundary

The CI results validate compilation, the dry-run bundles, and the automated fixtures in this repository. They do not prove live Durable Object behavior, live D1 migration application, production identity lifecycle enforcement, or deployment correctness. The tenant lifecycle case TEN-02 remains open. The D1 migration has not been applied.

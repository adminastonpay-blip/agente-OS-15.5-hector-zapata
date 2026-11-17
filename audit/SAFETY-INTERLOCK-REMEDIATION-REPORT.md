# ASTON OS — SafetyInterlock Fail-Closed Remediation

**Base:** `main` SHA `077331484f0cbfae4a23139564000117510a6767`  
**Branch:** `fix/safety-interlock-fail-closed-01`  
**Scope:** isolated source remediation and regression tests only.  
**Production / Cloudflare:** untouched.  
**Merge status:** not merged.

## Implemented in this branch — pending CI verification

1. `AgentNode.safetyCheck()` now requires the SafetyInterlock response contract version `1`.
2. Only the three documented decision statuses are accepted: `allowed`, `denied`, and `pending_approval`. A pending decision without an approval ID is rejected.
3. Interlock evaluation has an application-enforced 2,000 ms deadline. Timeout aborts the request and returns deny. A late response cannot change the already-settled decision.
4. Tool execution requires the exact status `allowed`; every other status is denied.
5. The real SafetyInterlock `/evaluate` endpoint now emits `contract_version: "1"`.
6. Secure ontology reads now release data only for an explicit `allow`; `require_approval` returns no records.
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

## Still not implemented / not verified

The three tenant-boundary scenarios from the original plan remain open:

- **TEN-01:** nested resource cross-tenant resolution through a real resource resolver and persistent fixture.
- **TEN-02:** cryptographically valid token for a revoked/archived tenant, backed by an authoritative tenant lifecycle registry. Current authentication code validates JWT claims and cryptography but no authoritative tenant status lookup was identified in the reviewed path.
- **TEN-03:** same resource ID under two tenants, tested through the actual resource route and tenant-scoped storage.

These are not counted as passing. The current repository evidence does not establish an authoritative tenant lifecycle table or a tenant-aware nested-link resolver suitable for safe implementation in this patch. They require a separate schema/route design and tests rather than a fabricated fixture.

## Evidence rules

- CI status and individual test traces must be inspected before any case is marked passed.
- Synthetic Safety DO tests exercise the real AgentNode route but not the real Durable Object SQL/policy engine.
- The authorization read tests exercise the actual `handleAccess` route handler and secure-read function using a deterministic D1 fixture; they do not claim a live Cloudflare D1 deployment.
- No vulnerability is marked production-validated.

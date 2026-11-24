# Universal Tool & Action Gate — Revocation Architecture

**Status:** DESIGN / IMPLEMENTATION GATE — NO RUNTIME ENFORCEMENT CLAIMED  
**Branch:** `feat/attestation-trust-fabric`  
**Related work:** PR #82 (Attestation + Trust Fabric), TEN-02 tenant lifecycle design  
**Production / staging changes:** NOT PERFORMED

## 1. Objective

Establish one mandatory authorization boundary immediately before every agent tool, API action, mutation, queue enqueue, delegated operation, and other externally observable side effect.

The gate must combine authenticated principal provenance, tenant and agent lifecycle, tenant-scoped Trust Fabric RBAC/policy, SafetyInterlock, risk/budget controls, human approval evidence, replay protection, and tamper-evident audit.

A model-generated plan, tool name, argument object, role, tenant, approval claim, or agent identity is untrusted input. A model may propose an action; it cannot authorize, approve, grant itself capabilities, or change policy.

## 2. Source inspection — current gaps

The following are source-code observations on the PR #82 head, not claims about a live deployment:

1. `src/do/agent-node.ts` receives `identity` in the JSON body of `POST /execute`. It checks for non-public identity fields, but those checks do not establish who authenticated or signed that identity. A Durable Object must not treat caller-supplied identity fields as proof of authentication.
2. `AgentNode` calls SafetyInterlock before planning, before each proposed tool, and before synthesis. It fails closed on a missing or malformed SafetyInterlock response. This is useful defense-in-depth, but it is not a universal authorization contract.
3. `AgentNode.runTool()` dispatches `search`, `graph_query`, `write`, and a reasoning fallback. The execution path does not visibly call Trust Fabric `/authorize` before each side effect.
4. `src/core/trust-fabric.ts` provides default-deny role evaluation and `src/do/trust-fabric.ts` stores actor role grants and tool policy rules. Role revocation exists for a tenant actor, but there is no authoritative tenant lifecycle state or agent lifecycle/revocation registry in this module.
5. Trust Fabric `/authorize` receives actor, roles, tenant, and tool in its request body. Its caller must be a trusted server boundary; the Durable Object's field validation alone cannot authenticate those claims.
6. `src/auth.ts` currently derives an Access tenant claim or synthesizes an `unassigned-…` tenant, maps the API key to `default`, and maps the sensor key to `ops`. These are not a substitute for an approved issuer/credential-to-tenant registry.
7. `audit/TEN-02-AUTHORITATIVE-TENANT-LIFECYCLE-DESIGN.md` explicitly records the missing provisioning authority and makes registry selection, issuer binding, and credential mapping prerequisites to runtime tenant lifecycle enforcement.

## 3. Target request contract

The gate should accept a server-constructed, immutable request object. No field below may be sourced as an authorization fact from model output or caller-controlled request JSON.

- `request_id`: unique correlation/idempotency identifier.
- `principal`: authenticated actor ID, authentication method, issuer/credential reference, and verified scopes.
- `tenant_id`: canonical ID resolved by the approved identity-to-tenant authority.
- `tenant_lifecycle_version`: authoritative monotonic version read for this request.
- `agent_id` and `agent_lifecycle_version`: server-registered agent identity and version.
- `delegation_id`: optional, server-issued, narrowly scoped delegation with expiry and audience.
- `action`: canonical registered tool/action identifier.
- `resource`: canonical resource type and tenant-bound resource ID.
- `arguments_digest`: digest of canonicalized, schema-validated arguments; do not use raw model arguments as authorization metadata.
- `policy_version`: resolved policy version.
- `budget_reservation`: server-computed call/cost/exposure reservation.
- `approval_reference`: optional immutable human approval bound to the exact action digest.
- `issued_at` / `expires_at`: bounded request lifetime.

Reject unknown fields where practical, unknown actions, malformed identifiers, oversized arguments, non-finite budgets, expired delegations, stale versions, and ambiguous resource ownership.

## 4. Mandatory decision pipeline

Immediately before each action side effect:

1. Verify the internal caller assertion or server-to-DO request provenance. Do not trust an `Identity` object merely because it is present in a JSON body.
2. Resolve and verify the principal and canonical tenant binding. Tenant headers, model output, and JWT custom claims are not provisioning authorities.
3. Read authoritative tenant lifecycle state. Require exactly `active`; deny on missing, suspended, revoked, archived, unknown, stale, or unavailable state.
4. Read authoritative agent lifecycle state. Require exactly `active`, correct tenant ownership, and matching lifecycle version.
5. Verify any delegation's issuer, audience, scope, tenant, agent, action, resource, expiry, and revocation state.
6. Resolve the action from a server-owned registry. Never dynamically execute a model-supplied function name, URL, SQL, shell command, or arbitrary code.
7. Evaluate Trust Fabric role grants and policy rules using server-verified roles. Default deny; no role or wildcard escalation from model/caller input.
8. Evaluate SafetyInterlock for the exact canonical action and arguments digest.
9. Evaluate risk envelope, per-plan and per-agent budgets, tenant limits, rate limits, and concurrency reservations.
10. Verify human approval where required. Approval must bind the exact action digest, tenant, agent, policy version, approver, and expiry; any changed argument requires a new approval.
11. Atomically consume the single-use authorization/reservation and append the decision/audit record where the backing store supports a true transaction. If atomicity cannot be guaranteed, deny the action.
12. Execute only after an explicit, current `allowed` decision. Record the outcome separately; never convert execution failure into authorization success.

The decision must be revalidated at the last possible point before the side effect. A previous `allowed` result is not a reusable bearer permit.

## 5. Revocation model

### Principal / credential revocation

- Revoke a specific credential independently from the actor and tenant.
- Keep credential secret material out of logs and audit payloads; store only an approved hash/fingerprint and issuer reference.
- Revocation increments a monotonic credential version or changes authoritative status.
- Old credentials and stale delegations must fail at the next authorization boundary.

### Agent revocation

Proposed lifecycle: `provisioning -> active -> suspended -> revoked -> archived`.

- `suspended` and `revoked` deny all new actions immediately.
- `revoked` is terminal for that agent ID; do not recycle identifiers.
- Reactivation from suspension requires a separately authorized workflow and a new lifecycle version.
- Revocation invalidates pending approvals, leases, delegations, scheduled actions, and outstanding reservations for that agent.
- Agent registration and ownership must be server-controlled and tenant-bound.

### Tenant revocation

Use the approved authoritative tenant lifecycle registry specified by TEN-02. Do not add a speculative registry, infer provisioning from JWT claims, or treat Trust Fabric's tenant-partitioned SQLite state as proof that a tenant is active.

- `suspended`, `revoked`, and `archived` deny all actions.
- Every transition increments a monotonic lifecycle version.
- Tenant revocation invalidates every agent, delegation, pending approval, lease, credential authorization, and queued-but-not-started action in that tenant.
- Never recycle tenant IDs.
- Registry unavailability, duplicate issuer bindings, unknown states, or version rollback => deny.

## 6. Consistency and race handling

- Initial enforcement must perform an authoritative lifecycle read at every action boundary; no positive cache is permitted.
- Any future cache needs an explicitly approved maximum staleness, invalidation mechanism, and measured revocation bound. Stale-positive cache entries may never authorize during registry failure.
- A decision must bind the lifecycle versions, policy version, action digest, and approval reference that were actually checked.
- If a lifecycle version changes between authorization and execution, abort and re-evaluate.
- Concurrent duplicate requests must not both consume the same approval, budget reservation, or delegation.
- If the persistence layer cannot atomically compare versions and consume the one-time authorization, do not claim race-safe revocation.

## 7. Required adversarial tests

Tests must exercise the actual HTTP/DO execution boundary and assert zero side effects on every denied case.

| Case | Expected result |
|---|---|
| Missing or forged internal caller assertion | Deny before model/tool execution |
| Caller supplies another actor's roles | Deny; roles are derived server-side |
| Unknown/unregistered tool | Deny |
| Model changes action arguments after approval | Deny; digest mismatch |
| Trust Fabric unavailable or malformed | Deny |
| SafetyInterlock unavailable, timeout, or malformed | Deny |
| Tenant unknown, suspended, revoked, archived, or registry unavailable | Deny |
| Tenant lifecycle version rollback or change during execution | Deny / re-evaluate |
| Agent unknown, suspended, revoked, or wrong-tenant | Deny |
| Revoked credential or stale delegation | Deny |
| Cross-tenant resource ID | Deny |
| Expired/replayed approval or delegation | Deny |
| Concurrent attempts to consume one approval/reservation | Exactly one winner |
| Budget exhausted or reservation persistence fails | Deny |
| Audit persistence required but unavailable | Deny |
| Active tenant + active agent + explicitly permitted read action | Allow (positive control) |
| Approved action with exact digest and valid human approver | Allow only within the approval's scope and lifetime |

For every denial, assert no D1 mutation, queue enqueue, Durable Object mutation, AI/tool invocation, external fetch, or protected data disclosure.

## 8. Implementation sequence and blockers

### Gate A — authority and provenance (blocking)

- [ ] Approve authoritative tenant provisioning/lifecycle owner and source of truth (TEN-02).
- [ ] Approve Cloudflare Access issuer/subject-to-tenant binding contract.
- [ ] Define explicit API-key and sensor credential records and migration; remove implicit shared-tenant authority only through a separately reviewed migration.
- [ ] Define authenticated Worker-to-Durable-Object assertion/provenance; do not trust body-supplied Identity.
- [ ] Define authoritative agent registry, ownership, lifecycle, and revocation authority.
- [ ] Define consistency and emergency recovery guarantees.

### Gate B — implementation

- [ ] Add server-owned tool/action registry with strict schemas and no dynamic dispatch.
- [ ] Add a single shared `authorizeAndReserveAction()` contract used by AgentNode and every other side-effecting execution path.
- [ ] Integrate Trust Fabric, tenant/agent lifecycle, SafetyInterlock, risk, budgets, approvals, replay protection, and audit.
- [ ] Make revocation invalidate outstanding approvals, leases, delegations, and queued work.
- [ ] Add route/DO adversarial tests and positive controls.

### Gate C — validation

- [ ] TypeScript and targeted unit tests pass.
- [ ] Real-route and Durable Object tests prove zero side effects on denial.
- [ ] Concurrency/replay tests prove single-use behavior.
- [ ] Staging-only integration review is separately authorized.
- [ ] Independent security review before any production change.

## 9. Explicit non-goals

This document does not change runtime authorization, authentication, tenant provisioning, credentials, database schemas, Durable Object bindings, secrets, Cloudflare resources, Shopify, NOC, or the Python tunnel. It does not claim universal enforcement or successful tenant/agent revocation.

**Current disposition:** `DESIGN READY FOR AUTHORITY REVIEW / RUNTIME IMPLEMENTATION BLOCKED BY GATE A`.

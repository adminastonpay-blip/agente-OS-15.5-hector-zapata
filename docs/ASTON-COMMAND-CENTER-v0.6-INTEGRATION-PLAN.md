# ASTON COMMAND CENTER v0.6 — Integration Plan

**Status:** implementation plan / review branch  
**Base:** `feat/aston-command-dashboard-v1`  
**Target:** ASTON OS 22 integration track  
**Safety posture:** read-only command surface; no production deployment, key rotation, destructive action, or live control-plane mutation in this phase.

## 1. Objective

Evolve the existing ASTON COMMAND dashboard into a governed operator command center that presents trustworthy operational state, evidence provenance, risk posture, and human-approval queues without implying that unavailable or unverified data is healthy.

## 2. Existing components discovered

| Component | Current repository role | Integration boundary |
|---|---|---|
| ASTON OS Worker | Runtime APIs, identity, tenant authorization, infrastructure, defense, audit, safety interlock | Authoritative runtime source; all reads remain authenticated and tenant-scoped |
| ASTON COMMAND dashboard | `src/dashboard/command.ts` serves a read-only HTML/CSS/JS view at `/command` | Presentation layer only; no direct privileged mutation |
| ATI 2.0 | Decision lifecycle, constitution, canonical hashing, HMAC decision passports | Trust/evidence layer; runtime cannot self-assert verified status |
| ARP-1 | Risk rating, risk envelopes, policy outcomes and approval semantics | Risk contract; preserve canonical semantics and version additive fields |
| Agent Attestation SDK | Portable JSON Schema and evidence references | Structural contract only; schema validity is not proof of truth |
| OTS Verifier | Isolated timestamp verification service | Report `invalid`, `unverified`, `pending`, `verified` distinctly |

## 3. v0.6 operator experience

1. **Command overview:** runtime version, deployment profile, last successful refresh, source freshness, and partial-outage state.
2. **Operations:** infrastructure inventory and service health, each item carrying source and observation time.
3. **Trust & provenance:** decision passport status, attestation status, evidence references, verifier provenance, and policy version.
4. **Risk & approvals:** ARP-1 outcome, risk-envelope summary, pending human approvals, and explicit actor attribution.
5. **Defense & incidents:** SafetyInterlock state and authorized incident summaries; no fabricated threat map or live threat claims without telemetry.
6. **Audit & integrity:** append-only event references, digest/anchor status, and exportable audit metadata with sensitive fields redacted.

## 4. Non-negotiable invariants

- Fail closed: missing identity, tenant, policy, verifier, key, or required evidence must never become an `allow` or `verified` state.
- Separate authentication, authorization, integrity verification, and external anchoring; one does not imply another.
- Bind every decision receipt to tenant, actor, policy version, canonical input digest, and timestamp.
- Human approval is a distinct actor/action and cannot be inferred from an agent request.
- Preserve existing canonical serialization and ARP-1 meanings; introduce new fields additively and version them.
- Dashboard endpoints are read-only in v0.6; all control actions remain out of scope until separately threat-modeled and approved.
- Tenant-scoped APIs must not leak cross-tenant counts, records, or identifiers.
- No production deployment, production key changes, external anchoring, or schema migration as part of this branch.

## 5. Implementation sequence

### Phase A — contract and route audit
- Map every dashboard fetch to its handler and authorization rule.
- Record response schemas, required identity, tenant scoping, rate limits, and error semantics.
- Replace optimistic labels with explicit `available`, `unavailable`, `stale`, `unverified`, and `verified` states.

### Phase B — typed read model
- Define a versioned, bounded Command Center response contract.
- Include `observed_at`, `source`, `tenant_scope`, and `status` metadata.
- Use partial results without turning failed sources into zero counts or green status.

### Phase C — trust and risk panels
- Integrate ATI passport verification and constitution evaluation through existing server-side modules.
- Display ARP-1 assessment and approval status without reimplementing or changing protocol semantics.
- Treat Attestation SDK payloads as claims until independent verification succeeds.
- Integrate OTS status only through the isolated verifier's explicit result.

### Phase D — hardening and verification
- Add route authorization, tenant-isolation, stale-data, partial-outage, XSS/output-escaping, and fail-closed tests.
- Run TypeScript checks and the existing safety/security test suites.
- Review dependency and secret scans; retain synthetic fixtures only.

## 6. Acceptance criteria

- Every displayed operational value has a source, timestamp, and explicit status.
- A failed API is shown as unavailable, never as zero, healthy, or clear.
- No cross-tenant information is observable in dashboard responses.
- No dashboard action mutates runtime state in v0.6.
- Invalid, missing, expired, replayed, or cross-tenant evidence is rejected or reported unverified.
- Existing API contracts and canonical hash fixtures remain compatible.
- All new tests pass; any unverified requirement is clearly listed as a release blocker.

## 7. Known limitations to preserve honestly

- A dashboard mock or conceptual globe is not live geospatial telemetry.
- An HMAC passport proves integrity under a shared secret, not independent identity or external trust.
- A valid attestation schema does not prove that its claims are true.
- A timestamp receipt is not verified until the complete proof chain is checked against trusted Bitcoin headers or an explicitly trusted verification backend.
- Prototype modules, drafts, and local tests are not production certification.

## 8. Change control

This plan is committed to an isolated feature branch based on the existing dashboard feature branch. Do not merge to `main`, deploy, rotate secrets, run production migrations, or enable mutating operator controls without a separate explicit release approval and rollback plan.

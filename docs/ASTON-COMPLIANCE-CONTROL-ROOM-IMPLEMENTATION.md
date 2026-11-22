# ASTON COMMAND — Private Compliance Control Room

**Status:** implementation contract / Phase 0  
**Date:** 2026-11-22  
**Target:** private ASTON COMMAND application and API  
**Infrastructure:** Cloudflare explicitly deferred to the final production stage

## 1. Security boundary

This control room is a private operator workspace. It is not a Shopify page and must not be embedded in the public storefront. Shopify's Legal & Compliance Center may link only to approved public documents; it must never expose evidence files, internal findings, incident records, approval actions, user identities, or control metadata.

All authorization is enforced server-side for every route and object. A hidden UI control is not an authorization control. Unknown routes, unknown permissions, missing tenant context, malformed identities, and unavailable authorization dependencies fail closed.

## 2. Repository baseline verified

The current codebase already contains:
- Access JWT verification in `src/auth.ts` (RS256, issuer, audience, expiry and not-before checks).
- Role and tenant claims on `Identity` in `src/types.ts`.
- An explicit API access boundary in `src/security/mvsp-access.ts`.
- A SHA-256 audit-chain helper in `src/security/audit-chain.ts`.
- A privileged, read-only Engineering overview in `src/routes/engineering.ts`.

These are reusable building blocks, not proof that the Compliance Control Room exists or is production-ready.

### Blocking authorization findings

1. `authenticate()` currently maps a valid global `API_KEY` to roles `admin, executor`, tenant `default`, and sovereign clearance. This is a broad shared credential, not a named operator identity or tenant-scoped authorization model. It must not be accepted as the normal human login path for the Compliance Control Room.
2. `authorizeApiRequest()` currently allows any authenticated identity to GET any non-public path; route-level authorization must therefore be explicit and object-scoped in addition to the central API boundary.
3. The current hash-chain helper verifies an in-memory sequence but does not itself provide durable append-only storage, concurrency control, external anchoring, or independent immutability.
4. Access roles are currently free-form strings. Compliance permissions require a closed permission vocabulary and server-side mapping from approved identity claims.
5. The current Engineering overview checks a coarse admin/executor role; it is not sufficient for evidence access, approvals, legal review, or incident access.

These gaps must be closed and covered by negative tests before private compliance data is stored.

## 3. Domain model

Use opaque stable IDs and tenant scoping on every record.

### Control
- `control_id`, `tenant_id`, `domain`, `title`, `requirement`, `scope`
- `implementation_summary`, `owner_id`, `status`
- `framework_mappings[]` (applicability reviewed, never assumed)
- `last_tested_at`, `next_review_at`, `created_at`, `updated_at`

Statuses: `not_assessed`, `gap`, `in_progress`, `implemented`, `independently_verified`.

### Evidence record
- `evidence_id`, `tenant_id`, `control_id`, `evidence_type`
- `source_system`, `source_reference`, `sha256`, `media_type`, `byte_length`
- `collected_at`, `collected_by`, `retention_class`, `classification`
- `review_status`, `reviewed_by`, `reviewed_at`, `supersedes_evidence_id`

Evidence bytes must be stored separately from metadata behind private authorization. Never put secrets, raw credentials, full customer exports, or unnecessary personal data into evidence records. Hashes prove byte identity, not truth or control effectiveness.

### Exception
- `exception_id`, `tenant_id`, `control_id`, `risk`, `reason`
- `compensating_controls`, `owner_id`, `expires_at`
- `approval_id`, `status`, `created_at`

Exceptions expire automatically for decision purposes; expired exceptions cannot silently remain accepted.

### Approval
- `approval_id`, `tenant_id`, `object_type`, `object_id`, `action`
- `requested_by`, `approved_by`, `decision`, `reason`, `created_at`
- `policy_version`, `correlation_id`

Requester and approver must be distinct for high-risk actions. Self-approval is denied server-side.

### Audit event
- `event_id`, `tenant_id`, `actor_id`, `action`, `object_type`, `object_id`
- `occurred_at`, `reason`, `correlation_id`, `policy_decision`
- `previous_hash`, `record_hash`, `external_anchor_ref`

Do not record secrets, tokens, full request bodies, raw evidence contents, or unnecessary personal data in audit events.

## 4. Permission model

Use closed permissions, not UI labels or arbitrary role strings:

| Permission | Minimum role | Notes |
|---|---|---|
| `compliance.dashboard.read` | auditor, compliance_manager | Tenant-scoped summary |
| `compliance.controls.read` | auditor, compliance_manager, control_owner | Only assigned/authorized scope |
| `compliance.controls.write` | compliance_manager, control_owner | Cannot self-approve |
| `compliance.evidence.read_metadata` | auditor, compliance_manager, control_owner | Classification and scope checked |
| `compliance.evidence.read_content` | evidence_reviewer, compliance_manager | Separate sensitive-content grant |
| `compliance.evidence.submit` | control_owner, evidence_collector | Immutable new version |
| `compliance.evidence.review` | evidence_reviewer, auditor | Reviewer must be distinct from submitter |
| `compliance.approvals.request` | compliance_manager, control_owner | Reason mandatory |
| `compliance.approvals.decide` | designated_approver | No self-approval |
| `compliance.exceptions.manage` | risk_owner | Dual approval for critical/high |
| `compliance.incidents.read` | incident_commander, legal_reviewer | Explicit case assignment |
| `compliance.audit.export` | auditor, compliance_manager | Logged, scoped, integrity manifest |

No role receives all permissions by default. Unknown roles and permissions deny. Cross-tenant object IDs return a non-enumerating denial.

## 5. API contract (proposed; not yet routed)

All endpoints require authenticated identity and explicit permission checks:

- `GET /v1/compliance/overview`
- `GET|POST /v1/compliance/controls`
- `GET|POST /v1/compliance/controls/:id/evidence`
- `GET /v1/compliance/evidence/:id` (metadata only)
- `GET /v1/compliance/evidence/:id/content` (separate content permission)
- `POST /v1/compliance/evidence/:id/reviews`
- `POST /v1/compliance/approvals`
- `POST /v1/compliance/approvals/:id/decision`
- `GET|POST /v1/compliance/exceptions`
- `GET /v1/compliance/audit`
- `POST /v1/compliance/audit/exports`

Do not implement write routes until persistence, transaction semantics, authorization, audit append, and tests are available together. No endpoint may infer tenant from a caller-supplied header or body field.

## 6. Control domains and initial catalogue

1. Corporate identity, jurisdiction and contracts.
2. Privacy, data inventory, retention, rights and deletion.
3. Processing agreements, subprocessors and transfer assessments.
4. Identity, privileged access, secrets, encryption and vulnerability management.
5. Secure development, dependency inventory, SBOM, provenance and SLSA target.
6. Incident response, continuity, recovery and change management.
7. Customer commitments, support, SLA and consumer disclosures.
8. Intellectual property and open-source license obligations.

Initial control statuses must be populated from repository evidence and review results, not marketing claims. A policy document alone does not prove a technical control is enforced. `independently_verified` requires independent testing and recorded reviewer evidence.

## 7. Required security tests

- Anonymous, malformed, expired, wrong-audience and revoked identity: deny.
- Valid identity with missing tenant claim: deny access to tenant records until explicit tenant assignment.
- Viewer or sensor identity attempts every write route: deny.
- API key attempts Compliance Control Room login and privileged operations: deny unless a separately approved machine identity policy explicitly scopes it.
- Cross-tenant read, write, evidence download and export: deny without revealing object existence.
- Guessed evidence IDs and approval IDs: deny.
- Submitter attempts own evidence review or approval: deny.
- Missing/expired approval, duplicate approval, replayed request and stale policy version: deny.
- Audit append failure or persistence unavailable: fail closed for sensitive mutations.
- Evidence hash mismatch, altered metadata, and incomplete export manifest: verification fails.
- Unknown route, method, permission, status and classification: deny.
- Rate, body-size and pagination limits enforced server-side.

## 8. Delivery phases

### Phase 0 — Contract and threat boundary
This document records the model, existing code baseline, blockers, API contract and acceptance tests.

### Phase 1 — Authorization foundation
Replace broad shared-key privilege for human workflows with named, tenant-bound identities; add closed permissions, object-level checks, explicit tenant assignment, and negative tests. Preserve compatibility only where separately justified.

### Phase 2 — Evidence registry
Implement versioned metadata, private content storage abstraction, digest verification, retention metadata, and reviewer workflow. No public URLs.

### Phase 3 — Approval, exception and audit workflows
Add separation of duties, dual approval, tamper-evident event append, export manifest and independent verification.

### Phase 4 — Command Center UI
Build a read-only dashboard first; add controls only after API enforcement and tests. UI must show evidence age, owner, scope, status and blockers without fabricating a compliance score.

### Phase 5 — Independent validation
Run tenant-isolation, authorization, audit-integrity, accessibility, recovery and penetration testing. Obtain counsel review for legal workflows.

### Final infrastructure stage
Only then evaluate Cloudflare bindings, D1/R2/Access, retention locks, secrets, service bindings and deployment. This phase is explicitly deferred and is not authorized by this document.

## 9. Release gates

- No broad shared API key accepted as an operator identity.
- Explicit tenant assignment and object-level authorization on every endpoint.
- Closed permissions and default-deny tests pass.
- Evidence access is private and separately authorized.
- Separation of duties and approval replay protections pass.
- Audit integrity and export verification pass.
- No secrets or personal data leaked to Shopify or public APIs.
- Independent security review and legal review complete.
- No Cloudflare resource, secret, binding, DNS, billing or deployment changes before the final stage.

## 10. Honest status

This PR is a design/implementation contract only. It does not claim that the private application, evidence registry, approvals, persistent audit storage, or SLSA Level 3 are implemented. The next code milestone is Phase 1: close the identity and authorization blockers before handling compliance evidence.

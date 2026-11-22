# ASTON Legal & Compliance Center

Status: architecture proposal / implementation baseline  
Owner: ASTON governance function (to be formally assigned)  
Last reviewed: 2026-11-22

## Purpose

Provide one auditable place for legal notices, privacy disclosures, security posture, compliance evidence and remediation status. The public Shopify experience is a transparency portal, not a certification, legal opinion, security guarantee or operational control plane.

The private ASTON COMMAND compliance workspace is a separate authenticated application. Shopify must never host secrets, internal audit evidence, personal data exports, incident details, credentials, privileged controls or administrator workflows.

## Product surfaces

### Public Shopify portal

Proposed route: `/pages/legal-compliance-center`

Publicly publish only approved and current material:
- Legal entity and contact details after primary-source verification.
- Terms, privacy notice, cookie notice, acceptable use and IP notices after counsel review.
- DPA and subprocessor information where applicable.
- Security overview describing implemented controls with evidence and scope.
- Service commitments only when contractually approved.
- Document version, effective date, owner and review date.
- Public incident/security contact process that does not expose internal response details.

Every public claim must link to an evidence record and carry one of these states: Draft, In review, Approved, Published, Superseded. Do not use a green badge or wording that implies certification merely because a control is planned.

### Private ASTON COMMAND Compliance Control Room

Separate app/API, not a Shopify page. Required controls:
- SSO/MFA where supported; server-side RBAC and tenant isolation.
- Default-deny authorization on every route and object.
- Least privilege, separation of duties, dual approval for high-risk changes.
- Immutable or tamper-evident audit events with actor, action, object, timestamp, reason and correlation ID.
- Evidence registry with provenance, hash, retention class, access policy and review history.
- Exception register with owner, risk acceptance, expiry and compensating controls.
- Incident workflow with restricted access and legally reviewed notification gates.
- Exportable audit packages with integrity verification.
- No public exposure of evidence attachments or internal control metadata.

## Control domains

1. Corporate identity, contracts and jurisdiction mapping.
2. Privacy governance: data inventory, purpose, lawful basis, controller/processor roles, rights handling, retention and deletion.
3. Data processing: DPA, subprocessor register, transfer mechanism assessment and vendor due diligence.
4. Security: identity, access, secrets, encryption, key lifecycle, network boundaries, secure development and vulnerability management.
5. Supply chain: SBOM, dependency policy, provenance, signed releases and SLSA target evidence.
6. Operations: incident response, business continuity, backup/restore tests and change management.
7. Customer commitments: SLA, support, cancellation/refund and consumer disclosures.
8. Intellectual property: ownership chain, third-party notices, open-source license inventory and trademark review.

## Evidence model

Each control record should contain:
- Stable control ID and framework mapping (framework applicability must be assessed, not assumed).
- Requirement, scope, implementation description and accountable owner.
- Status: Not assessed / Gap / In progress / Implemented / Independently verified.
- Evidence references, immutable digest, collection timestamp and source.
- Last test date, next review date, exceptions and remediation ticket.
- Approval identity and approval timestamp.

An implementation claim is not independently verified until a qualified independent reviewer has tested it. A policy document alone is not evidence that a technical control is enforced.

## Public disclosure rules

- Never claim "unbreakable", "attack-proof", "bank-grade", universal legal immunity or absolute protection.
- Never claim SOC 2, ISO 27001, PCI DSS, GDPR certification or SLSA Build Level 3 without current, applicable and verifiable evidence.
- Describe SLSA Build Level 3 as a target until trusted build isolation, provenance generation and verification requirements are met.
- Distinguish legal applicability from certification. A law's applicability depends on facts, role, territory and processing.
- Keep legal drafts unpublished until the correct legal entity, addresses, contacts, effective dates, jurisdictions and counsel approvals are recorded.
- Do not publish placeholders or unsupported Delaware/US entity claims.
- Avoid exposing security-sensitive architecture details that increase attack surface.

## Shopify implementation boundary

Use the existing unpublished candidate theme only (theme ID 163140370517). Keep the published theme untouched. The public page is informational and contains no authentication or privileged actions. Do not add a fake live compliance score, fake audit feed, fabricated uptime, or unverified Worker health status.

Page content must remain editable in Shopify's theme editor. Legal content should be managed as versioned documents, not silently overwritten as marketing copy. Shopify publication requires a separate explicit approval.

## Cloudflare boundary

Cloudflare work is deferred to the explicitly designated final infrastructure stage. This document defines future integration requirements only; it does not authorize Worker, D1, R2, Access, secrets, bindings, DNS or deployment changes.

## Release gates

1. Legal entity and jurisdiction facts verified from primary records.
2. Counsel approves public legal text for intended markets and customer types.
3. Privacy data map, subprocessor list, retention schedule and transfer assessments match production reality.
4. Public claims are mapped to evidence and reviewed.
5. Private console passes access-control, tenant-isolation, audit-integrity and penetration tests.
6. Evidence export integrity and recovery procedures are tested.
7. No secrets, private evidence or personal data appear in public Shopify assets.
8. Accessibility and desktop/mobile visual QA completed.
9. Shopify page remains unpublished until separate approval.

## Initial known gaps

- Repository previously reported public visibility while a licensing note described it as private; resolve repository access policy.
- No root repository license was evidenced in the reviewed files; do not infer a blanket ASTON license.
- OpenSSL was not found in the inspected dependency/code paths; current inspected cryptographic calls use Web Crypto APIs. Recheck full dependency inventory before making a final SBOM/license statement.
- SLSA Build Level 3 is not evidenced as achieved.
- Legal entity, governing law, counsel approvals and public contact details require verification.
- No private compliance application or end-to-end evidence registry is claimed complete by this architecture document.

## Definition of done

The public page is a clear, accessible and accurate index of approved disclosures. The private control room enforces access server-side and records verifiable evidence. All status labels reflect tested reality, and every unsupported claim remains unpublished.

# ASTON OS — incident response runbook

This is an operational template. Assign named responders and customer/legal contacts before treating it as operational.

## Severity

- **SEV-1 / Critical:** confirmed unauthorized customer-data access, active credential compromise, cross-tenant exposure, or production control-plane compromise.
- **SEV-2 / High:** exploitable authorization bypass, material exposure risk, or widespread integrity failure.
- **SEV-3 / Moderate:** contained vulnerability with no evidence of customer-data access.
- **SEV-4 / Low:** hardening issue or limited-impact defect.

## Response sequence

1. **Declare and assign:** record UTC discovery time, incident commander, technical lead, communications owner, affected services, and initial severity.
2. **Contain safely:** preserve evidence where feasible. Revoke/rotate compromised API keys and staging secrets through the authorized secret manager. Restrict affected routes or access policies through approved change control. Do not delete logs.
3. **Preserve evidence:** export relevant Actions run IDs, deployment IDs, Cloudflare audit events, Worker logs, D1/R2 references, request IDs and timestamps. Store evidence with restricted access and collection metadata.
4. **Assess scope:** identify tenants, data classes, time window, access paths, downstream processors, and whether credentials or personal data were exposed. Do not copy raw sensitive payloads into tickets.
5. **Eradicate and recover:** patch on a reviewed branch, test in isolated staging with synthetic data, verify recovery and backups, then obtain explicit production-release approval.
6. **Notify:** notify affected customers and authorities according to applicable law and contracts. MVSP's baseline calls for notification within 72 hours of discovery for breaches affecting sensitive information; obtain legal review for the applicable jurisdiction.
7. **Review:** complete root-cause analysis, corrective actions, customer security bulletin if action is required, and lessons learned.

## Evidence and communications

- Keep an immutable incident timeline in UTC.
- Record affected versions, commits, workflow run URLs, and deployment identifiers.
- Never include secrets, passwords, private keys, or unnecessary personal data in incident records.
- Communicate the nature of the incident, contact information, likely consequences, and remediation steps as facts are confirmed.

## Recovery checklist

- [ ] Compromised credentials revoked/rotated.
- [ ] Affected routes and permissions reviewed.
- [ ] Cross-tenant access tested.
- [ ] Production and staging bindings verified separately.
- [ ] Backups and restoration tested.
- [ ] Customer/legal notifications completed where required.
- [ ] Root cause and patch linked to reviewed commits.
- [ ] Follow-up actions assigned owners and due dates.

## Required owner assignments

Record primary and backup contacts for incident command, security, Cloudflare administration, GitHub administration, privacy/legal, and customer communications in an access-controlled operations record.

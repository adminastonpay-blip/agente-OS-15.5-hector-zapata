# ASTON OS — Security Incident Response Playbook

**Status:** Operational draft. Assign named on-call owners and validate contacts before production.

## Objectives
Protect people and customer data, contain unauthorized access, preserve evidence, restore trusted service, and meet contractual/legal notification duties.

## Severity
- **SEV-1 Critical:** confirmed privileged compromise, broad customer-data exposure, destructive control-plane access, or ongoing material service compromise.
- **SEV-2 High:** suspected unauthorized access to sensitive systems/data, compromised integration credential, or material tenant-isolation concern.
- **SEV-3 Moderate:** contained security event with limited scope and no confirmed sensitive-data exposure.
- **SEV-4 Low:** blocked attempt, policy violation, or vulnerability without evidence of compromise.

Severity must be raised when scope is uncertain.

## First response
1. Record reporter, UTC/local timestamps, affected systems, observed indicators and current impact.
2. Assign incident commander and technical lead; open a restricted incident record.
3. Preserve logs, request IDs, relevant configuration and forensic evidence. Record custody and avoid destructive cleanup.
4. Contain safely: revoke/rotate exposed credentials, disable affected tokens/integrations, isolate impacted workloads, apply temporary deny rules. Preserve access needed for investigation.
5. Assess affected tenants, data categories, time window, persistence, lateral movement and third-party dependencies.
6. Engage legal/privacy owner immediately if personal data or regulated information may be involved.
7. Communicate only through approved channels; do not speculate or disclose secrets.

## Notification and escalation
- Internal escalation: [ON-CALL CONTACTS / ESCALATION TREE]
- Cloud/hosting provider: [VERIFIED SUPPORT CHANNEL]
- Customer contact: [CONTRACTUAL CONTACT AND APPROVED TEMPLATE]
- Regulatory/data-subject notification: legal/privacy owner determines applicable duties and deadlines.
- Never promise a notification deadline until counsel confirms the applicable law and contract.

## Recovery
1. Eradicate root cause and verify credentials, policies, dependencies and access.
2. Restore from trusted backups or known-good deployment where needed.
3. Validate authorization, tenant isolation, audit events and core health checks.
4. Monitor for recurrence and maintain heightened logging.
5. Obtain incident commander and service owner approval before closing.

## Post-incident
Within a defined internal target [SET TARGET], produce timeline, scope, root cause, impact, evidence, notifications, remediation owners and due dates. Track corrective actions to closure.

## Evidence checklist
- Incident ID, severity, commander, timestamps
- Affected accounts, tenants, services, regions
- Logs, traces, request IDs, deployment/configuration diffs
- Credential rotation/revocation evidence
- Data exposure assessment and legal decision log
- Customer/provider/regulator communications
- Recovery validation and follow-up actions

## Production prerequisites
- [ ] Named primary and backup incident commanders
- [ ] Verified 24/7 escalation route or accurately stated support hours
- [ ] Credential rotation and revocation runbook tested
- [ ] Log access, retention and tamper protection verified
- [ ] Backup/restore and rollback tested
- [ ] Customer and provider contact details validated
- [ ] Legal/privacy notification decision tree approved

# ASTON OS Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub Security Advisories:
https://github.com/adminastonpay-blip/agente-OS-15.5-hector-zapata/security/advisories/new

Do not publish exploit details, credentials, customer information, personal data, or production payloads in public issues or pull requests. If private reporting is unavailable to external reporters, the product owner must publish an accessible security contact before external customer onboarding.

## Scope and testing rules

Scope includes Worker endpoints, authentication/authorization, tenant isolation, Durable Objects, D1/R2/Queues/Vectorize integrations, staging configuration, and GitHub Actions.

Testing must be non-destructive and use synthetic data in isolated staging. Do not access or modify other tenants' data, exfiltrate data, run denial-of-service tests, or test production without written authorization.

**This policy does not grant legal safe harbor.** The product owner must approve and publish explicit safe-harbor terms before inviting external testing. MVSP 1.1 remains partial until this is completed.

## Proposed triage targets

- Acknowledge a report within 3 business days.
- Triage and assign severity within 5 business days.
- Prioritize actively exploited vulnerabilities immediately.
- Remediate material application vulnerabilities within 90 days, or document risk acceptance and compensating controls.
- Coordinate customer-facing security bulletins when a fix requires customer action.

These are proposed operating targets, not a customer SLA, until accountable security and communications contacts are assigned.

## Credentials and data

- Never commit tokens, passwords, private keys, signing seeds, customer evidence, personal data, or production configuration.
- Keep staging and production credentials/resources separate.
- Store secrets only in Cloudflare secrets or an approved secret manager.
- Rotate exposed credentials and assess Git history, logs, releases, caches, and artifacts; deleting the latest copy is not remediation.
- Do not paste secrets into issues, PR comments, logs, or AI prompts.

## Runtime and release safety

- Deny by default when identity, authorization, policy, binding, or required evidence is absent or invalid.
- Bound request sizes, retries, concurrency, execution time, and spend.
- Require human approval for high-impact or irreversible operations.
- Protect production Worker, Wrangler config, bindings, DO migrations, D1, Queues, R2, Vectorize, routes, and secrets.
- Require review, tests, dependency and secret scans, type checks, and Wrangler dry-runs before staging release.
- A dry-run is not a deployment. A passing staging check is not production approval.
- No merge, production deployment, migration, or secret creation without explicit release approval and rollback plan.

This policy does not claim that ASTON OS is certified or that all vulnerabilities can be detected automatically.

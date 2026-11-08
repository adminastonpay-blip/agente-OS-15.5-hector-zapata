# ASTON OS Security Policy

## Reporting
Do not disclose vulnerabilities, credentials, customer data, or exploit details in public issues. Use GitHub private vulnerability reporting if enabled; otherwise contact the repository owner through a verified private channel. Do not test production or third-party targets without written authorization.

## Credentials and data
- Never commit tokens, passwords, private keys, signing seeds, customer evidence, personal data, or production configuration.
- Keep staging and production credentials/resources separate.
- Store secrets only in Cloudflare secrets or an approved secret manager.
- Rotate any exposed credential immediately; assess Git history, logs, releases, caches, and artifacts. Removing the latest copy is not remediation.
- Do not paste secrets into issues, PR comments, logs, or AI prompts.

## Runtime safety
- Deny by default when identity, authorization, policy, binding, or required evidence is absent or invalid.
- Bound request sizes, retries, concurrency, execution time, and spend.
- Require human approval for high-impact or irreversible operations.
- Keep audit paths read-only unless an explicit authorization contract exists.
- Never run unapproved campaigns against production or third-party systems.

## Change and release policy
- Production Worker, Wrangler config, bindings, DO migrations, D1, Queues, R2, Vectorize, routes, and secrets are protected assets. Staging work must be additive and isolated.
- Require review, tests, dependency and secret scans, targeted type checks, and Wrangler dry-run before staging release.
- A dry-run is not a deployment. A passing staging check is not production approval.
- No merge, production deployment, migration, or secret creation without explicit release approval and rollback plan.

## Scope
This policy does not claim that ASTON OS is certified or that all vulnerabilities can be detected automatically. Reported issues are triaged based on impact and reproducibility; no response-time SLA is claimed.

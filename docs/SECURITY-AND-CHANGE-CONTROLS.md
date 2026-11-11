# ASTON OS Security and Change Controls

**Status:** Staging-branch governance document. Production configuration remains authoritative and unchanged.

## Non-negotiable controls
- No direct edits to the production branch or production Wrangler configuration during staging work.
- Never delete, rename, replace, or silently repurpose existing bindings, Durable Object migrations, D1 databases, Queues, R2 buckets, Vectorize indexes, secrets, routes, or custom domains.
- Add resources only under distinct staging names and after documenting ownership, isolation, cost, and rollback.
- Never commit secret values, customer evidence, signing keys, tokens, or personal data.
- Keep production and staging credentials separate; never copy production credentials into staging.
- Deny by default on missing identity, policy, authorization, required binding, or evidence.
- Bound request sizes, execution, retries, concurrency, and spend. Require human approval for consequential actions.
- Do not run active campaigns against production or third-party systems without written authorization and scoped test plan.

## Pull request and release controls
- Use isolated branches and Draft PRs for incomplete work.
- Require reproducible tests, targeted type checks, dependency review, secret scanning, and Wrangler dry-run before staging deployment.
- Report targeted checks separately from repository-wide CI. Do not mask existing failures.
- A successful dry-run is not a deployment. A staging deployment is not production approval.
- No merge, production deployment, binding migration, or secret creation without explicit release approval and reviewed rollback plan.
- Preserve commit history; do not force-push or rewrite protected history to conceal or clean up a disclosure.

## Disclosure and intellectual property
Repository visibility does not itself grant a software license. Treat implementation code and operational details as reserved unless a specific approved license says otherwise. Do not publish proprietary scoring thresholds, customer data, private integrations, secrets, or signing-key material. Review dependencies and contributor provenance before commercial release.

## Incident response
If a secret or sensitive artifact is exposed: revoke/rotate it, assess logs and downstream access, preserve incident metadata, and notify affected parties as required. Removing the visible file is not sufficient; history, caches, releases, logs, and artifacts must also be assessed.

## Current boundary
This document does not change runtime behavior, bindings, secrets, migrations, or deployment state. It is a repository governance baseline and must be reviewed before production adoption.

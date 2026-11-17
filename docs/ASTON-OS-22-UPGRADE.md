# ASTON OS 22 — Upgrade and compatibility dossier

## Scope
This branch is a non-production hardening and evolution branch. It does not alter the deployed Worker, production Cloudflare resources, database schema, Durable Object class names, public route names, or secrets. The `main` branch remains unchanged.

## Changes in this branch
- Chat memory is isolated by verified identity, tenant, and caller session identifier. Anonymous chat does not persist Durable Object history.
- Regression tests cover session namespace stability and cross-actor / cross-tenant separation.
- CI runs the security regression suite and TypeScript checks.
- The staging config no longer references an unprovisioned R2 bucket; audit-chain persistence remains in the staging Safety Durable Object, while external R2 anchoring is explicitly disabled until the bucket is provisioned.
- Staging observability enables both Worker logs and traces.
- Infrastructure status no longer labels a merely configured AI Gateway ID as live, and reports core Durable Objects as live only when the required bindings are present.
- A Cloudflare readiness report documents remaining resource mismatches and safe remediation order.

## Risks requiring operator-controlled migration
1. **Production D1:** the configured `sos-db` database ID returned Cloudflare 404 / error 7404 during account inspection. Do not substitute the empty `db1` database. Confirm the intended database ID and schema before changing the production binding.
2. **Production R2:** R2 API access returned error 10042 during inspection. Provision/enable R2 and verify the target bucket before binding `JOURNAL` or `AUDIT_ARCHIVE`.
3. **Queue consumer:** the existing Queue has no configured consumer, and the repository consumer functions are not wired to the Worker default export. Do not treat the producer binding as an operational ETL/recovery pipeline.
4. **AI Gateway:** the configured `sovereign-gateway` ID was not present in the account's Gateway listing. Runtime already falls back to direct Workers AI; verify/create the Gateway only if its policies, logging, or cache are required.
5. **Credential separation:** `API_KEY` is accepted for privileged bearer authentication and sensor authentication. Provision a dedicated `SENSOR_API_KEY` and migrate clients before removing legacy behavior. Do not rotate the existing key until clients are migrated.
6. **Tenant assignment:** API-key identity currently maps to the `default` tenant. Production multi-tenant usage needs tenant-specific credentials/identity claims and a data-scope review.
7. **Reproducible builds:** the repository has no package lockfile. Generate and commit one from a trusted, reviewed environment before switching CI from `npm install` to `npm ci`.
8. **Runtime verification:** CI dry-runs validate bundle/configuration only. They do not deploy the Worker or prove live Cloudflare binding behavior.

## Validation gate
- `npm run check`
- `npm run test:security`
- `npx wrangler deploy --dry-run`
- `npx wrangler deploy --dry-run --config wrangler.staging.toml`
- Deploy isolated staging only after confirming Workers AI and Durable Objects availability and configuring `AUDIT_SECRET`.
- Test staging health, audit claim/replay protection, policy gate, chat model response, rate limiting, and output guard.
- Test R2 checkpoint anchoring separately only after a staging bucket is provisioned and bound.

## Rollback
The branch is isolated from `main`. Do not merge until CI passes and the staging checklist is signed off. If any regression appears, close the PR and leave `main` untouched. Existing pre-v2 session history remains in its original Durable Objects and is not deleted; new sessions use a new isolated namespace.

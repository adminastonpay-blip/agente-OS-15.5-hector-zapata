# ASTON OS 22 — Upgrade and compatibility dossier

## Current repository state

The hardening changes described here were merged into `main` by PR #17 on 2026-11-17. This document describes repository state; it does **not** claim that the Worker was deployed or that production Cloudflare resources were changed. The merge changed source, tests, CI and documentation only.

## Changes present in main

- Chat memory is isolated by verified identity, tenant, and caller session identifier. Anonymous chat does not persist Durable Object history.
- Regression tests cover session namespace stability and cross-actor / cross-tenant separation.
- CI runs the security regression suite and TypeScript checks.
- The staging config no longer references an unprovisioned R2 bucket; audit-chain persistence remains in the staging Safety Durable Object, while external R2 anchoring is explicitly disabled until the bucket is provisioned.
- Staging observability enables both Worker logs and traces.
- Infrastructure status no longer labels a merely configured AI Gateway ID as live, and reports core Durable Objects as live only when the required bindings are present.
- A Cloudflare readiness report documents remaining resource mismatches and safe remediation order.

## Integration status: Risk, Trust and OTS

The companion repositories currently provide integration contracts and verification-boundary documentation. The merges of those documents do not establish that their services are wired into this Worker or operational end-to-end. Treat each integration as pending until there is an implementation, explicit binding/API contract, negative-path behavior, and automated integration test in an isolated environment.

In particular:
- Risk: a documented envelope or protocol is not evidence that an external risk service is called.
- Trust: signatures/HMAC and identity metadata are not authorization or an external trust anchor by themselves.
- OTS: `verified` must only be returned after validating the proof against trusted Bitcoin headers or a trusted verifier; missing connectivity must remain unverified/unavailable.

## Recovery safety boundary

Recovery diagnostics now require an exact HTTPS origin allowlist (`RECOVERY_ALLOWED_ORIGINS`). With no allowlist, the workflow does not make an outbound probe. Automated Cloudflare Load Balancer mutation is disabled in this workflow: an approval is recorded as requiring a manual operator action and never triggers a Cloudflare API PATCH. This is intentional until operator identity, authorization, durable intent/result journaling, target scoping and idempotent execution are independently designed and tested.

The recovery journal remains mandatory. If the R2 `JOURNAL` binding is unavailable, the workflow fails rather than reporting a completed, journaled result.

## Remaining infrastructure risks requiring operator-controlled migration

1. **Production D1:** the configured `sos-db` database ID returned Cloudflare 404 / error 7404 during account inspection. Do not substitute the empty `db1` database. Confirm the intended database ID and schema before changing the production binding.
2. **Production R2:** R2 API access returned error 10042 during inspection. Provision/enable R2 and verify the target bucket before binding `JOURNAL` or `AUDIT_ARCHIVE`.
3. **Queue consumer:** the existing Queue has no configured consumer, and the repository consumer functions are not wired to the Worker default export. Do not treat the producer binding as an operational ETL/recovery pipeline.
4. **AI Gateway:** the configured `sovereign-gateway` ID was not present in the account's Gateway listing. Runtime already falls back to direct Workers AI; verify/create the Gateway only if its policies, logging, or cache are required.
5. **Credential separation:** `API_KEY` is accepted for privileged bearer authentication and sensor authentication. Provision a dedicated `SENSOR_API_KEY` and migrate clients before removing legacy behavior. Do not rotate the existing key until clients are migrated.
6. **Tenant assignment:** API-key identity currently maps to the `default` tenant. Production multi-tenant usage needs tenant-specific credentials/identity claims and a data-scope review.
7. **Reproducible builds:** the repository has no package lockfile. Generate and commit one from a trusted, reviewed environment before switching CI from `npm install` to `npm ci`.
8. **Runtime verification:** CI dry-runs validate bundle/configuration only. They do not deploy the Worker or prove live Cloudflare binding behavior.

## Validation gate before release

- `npm run check`
- `npm run test:security`
- `npx wrangler deploy --dry-run`
- `npx wrangler deploy --dry-run --config wrangler.staging.toml`
- Deploy isolated staging only after confirming Workers AI and Durable Objects availability and configuring `AUDIT_SECRET`.
- Test staging health, audit claim/replay protection, policy gate, chat model response, rate limiting, output guard, and recovery origin allowlisting.
- Test R2 checkpoint anchoring separately only after a staging bucket is provisioned and bound.
- Keep Risk, Trust and OTS marked pending until their end-to-end integration gates pass.

## Rollback and release authority

These corrections are prepared on an isolated branch and proposed through a pull request. Do not merge or deploy without explicit operator approval. If any regression appears, close the PR and leave `main` untouched. No existing session history or production data is migrated or deleted by these changes.

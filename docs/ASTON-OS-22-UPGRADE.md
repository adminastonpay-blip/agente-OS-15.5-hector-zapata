# ASTON OS 22 — Upgrade and compatibility dossier

## Scope
This branch is a non-production hardening and evolution branch. It does not alter the deployed Worker, Cloudflare resources, database schema, Durable Object class names, public route names, or secrets. The `main` branch remains unchanged.

## Changes in this branch
- Chat memory is isolated by verified identity, tenant, and caller session identifier. Anonymous chat does not persist Durable Object history.
- A regression test suite covers session namespace stability and cross-actor / cross-tenant separation.
- The CI workflow runs the existing security regression suite on pull requests and pushes.
- TypeScript configuration includes workflow source files instead of silently excluding `src/workflows/**`.

## Existing risks requiring operator-controlled migration
1. **Credential separation:** `API_KEY` is accepted for both privileged bearer authentication and the sensor header. Provision a dedicated `SENSOR_API_KEY` and migrate sensor clients before removing legacy shared-key behavior. Do not rotate or invalidate the existing key until clients are migrated.
2. **Tenant assignment:** API-key identity currently maps to the `default` tenant. Production multi-tenant usage needs tenant-specific credentials/identity claims and a data-scope review.
3. **Reproducible builds:** the repository has no package lockfile. Generate and commit a lockfile from a trusted, reviewed environment before switching CI from `npm install` to `npm ci`.
4. **Runtime verification:** this branch has not been deployed or exercised against production Cloudflare bindings. Validate in isolated staging first.

## Validation gate
- `npm run check`
- `npm run test:security`
- `npx wrangler deploy --dry-run`
- `npx wrangler deploy --dry-run --config wrangler.staging.toml`
- Staging tests for chat persistence, cross-tenant isolation, Access JWT rotation, sensor authentication, rate limiting, audit anchoring, and OTS verification.

## Rollback
The branch is isolated from `main`. Do not merge until CI passes and the staging checklist is signed off. If any regression appears, close the PR and leave `main` untouched. Existing pre-v2 session history remains in its original Durable Objects and is not deleted; new sessions use a new isolated namespace.

# ASTON Tenant Authority — Staging Migration Chain v1

Status: source prepared; CI pending; no D1 migration has been applied.

## Target
Dedicated staging database: `aston-rag-staging-db` (`457d72d6-388b-4dad-bdd0-b32d3e905e00`), referenced only by `wrangler.staging.toml`.

## Ordered chain
1. `migrations-staging/0001_staging_baseline.sql` — existing isolated baseline.
2. `migrations-staging/0002_tenant_lifecycle.sql` — tenant lifecycle, idempotency, append-only audit, transition triggers.
3. `migrations-staging/0003_tenant_identity_registry.sql` — Access issuer/subject and API/sensor credential bindings, uniqueness constraints and active-tenant guards.

The staging Worker uses `migrations-staging`; production/preview `wrangler.toml` uses a different migration directory. Do not change production migration routing as part of this staging task.

## Required pre-apply checks
- Confirm the staging database ID and account in the Cloudflare dashboard.
- Run `wrangler d1 migrations list aston-rag-staging-db --remote --config wrangler.staging.toml` and confirm migration 0001 is recorded and 0002/0003 are pending.
- Inspect the remote schema for pre-existing `aston_tenants`, `aston_tenant_lifecycle_idempotency`, `aston_tenant_lifecycle_audit`, and `aston_tenant_identity_bindings` tables/triggers before applying.
- Back up the staging database and capture the migration list/schema snapshot.
- Apply only after explicit operator authorization, then verify table/index/trigger definitions and execute the staging authority tests against the real D1 binding.

## Safety boundary
No production D1, Cloudflare production binding, secret, Worker deployment, Durable Object, Queue, or Vectorize resource is changed by this source preparation. Never use the production database ID with this migration chain.

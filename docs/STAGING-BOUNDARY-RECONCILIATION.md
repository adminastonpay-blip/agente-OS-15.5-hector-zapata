# Staging boundary reconciliation — 2026-11-21

## Status

**Investigation only. No Cloudflare resources, bindings, secrets, production files, or deployments were changed.**

This report corrects the initial interpretation of the runbook. It records verified conflicts between the documented audit-only boundary, Wrangler config, route guard, workflow, and live Cloudflare account. It is not deployment approval.

## Verified findings

1. `docs/AUDIT-STAGING-RUNBOOK.md` explicitly describes an audit-only Worker. It says the profile should have AI and the isolated `SafetyInterlock` Durable Object, and intentionally no D1, Queue, R2, Vectorize, Hyperdrive, or session bindings. It says only health and the secret-protected audit endpoint are allowed.
2. `wrangler.staging.toml` contradicts that runbook. It configures:
   - Queue producer and consumer on `aston-global-queue-preview`;
   - D1 binding `DB` to `aston-rag-staging-db`;
   - Vectorize binding `VECTORIZE` to `aston-rag-staging-index`;
   - AI and SafetyInterlock.
   Its comments call these dedicated/isolated resources, but the live Queue is not isolated.
3. Live Cloudflare account `70e8821e0eeeccb401d9ba0b3f4dbfe8` confirms `aston-global-queue-preview` has 11 producers and one consumer. The consumer is `agente-os-15-5-hector-zapata`, with batch size 10 and max retries 3. Producer names include multiple ASTON staging/fix workers. This Queue is shared and must not be described or used as a dedicated staging Queue.
4. The resource reuse is broader than the Queue: root `wrangler.toml` declares the same D1 database ID `457d72d6-388b-4dad-bdd0-b32d3e905e00` (`aston-rag-staging-db`) and the same Vectorize index name (`aston-rag-staging-index`) under `[previews]` that `wrangler.staging.toml` declares as direct staging bindings. These are Preview resources reused by the staging config, not proven exclusive to the new audit Worker. The D1 currently reports 21 tables from the prior inspection; do not assume it is empty or safe for a baseline migration.
5. The live account's Worker script inventory returned only `agente-os-15-5-hector-zapata`; a direct GET for `aston-os-21x-audit-staging` returned Cloudflare 404 / Worker does not exist. The staging config is therefore not evidence of a deployed Worker.
6. `src/audit/staging-route-guard.ts` allows health, audit, `/v1/etl/ingest`, `/v1/rag/ingest`, and `/v1/rag/query`. The runbook describes a narrower audit-only allowlist. The guard itself does not allow every application route, but ETL/RAG are explicitly enabled.
7. `src/index.ts` exposes a separate `/v1/etl/enqueue` path in the v21 router. That path sends `{ ...body, tenant, actor, ts }` without validating the ETL `text` contract. `src/etl-ingest.ts` sends `{ tenant, actor, text, source, kind }` after Access identity/role validation. `src/etl.ts` requires tenant, actor and text and retries failures. The producer contracts are inconsistent.
8. There are three relevant GitHub workflows:
   - `.github/workflows/cloudflare-ci.yml`: pull-request CI; checks and Wrangler dry-runs for production and staging config only.
   - `.github/workflows/audit-staging-validation.yml`: tests/typecheck and staging dry-run; its push trigger names the historical branch `feat/audit-staging-harness-21x`.
   - `.github/workflows/deploy-isolated-staging.yml`: manual `workflow_dispatch` only, requiring exact input `DEPLOY-STAGING`.
9. The manual deploy workflow is high impact even though manually gated: after checking Cloudflare and audit secrets, it runs remote D1 migrations **before** the dry-run, deploys `wrangler.staging.toml`, and installs `AUDIT_SECRET`. The confirmation string is not a substitute for independent release review. Do not dispatch this workflow during the current investigation.
10. `docs/AUDIT-STAGING-RUNBOOK.md` also references Workers Builds configuration for branch `feat/audit-staging-harness-21x` and a deploy command. The live Cloudflare API confirms no `aston-os-21x-audit-staging` Worker script, but Workers Builds project settings were not yet verified. Do not infer that no connected build/deploy project exists solely from the Worker script listing.

## Risk assessment

- **Critical release blocker:** The manual staging deploy workflow runs `wrangler d1 migrations apply ... --remote` before deployment. The exact migration contents and resulting schema impact must be reviewed before anyone dispatches it.
- **High:** The audit-only runbook and actual staging Wrangler bindings/route allowlist do not describe the same security boundary.
- **High:** The configured Preview Queue is shared by 11 producers and consumed by the main Worker. Attaching the staging Worker as another consumer or sending test messages could affect live processing.
- **High:** Staging config also reuses the same D1 and Vectorize resources declared under the root Worker's Preview environment. Preview and audit staging are therefore not resource-isolated.
- **Medium:** The two ETL ingress routes enqueue different shapes; the generic route can enqueue a body without the required `text` field, leading to retries.
- **Unresolved:** Workers Builds project settings, deploy hooks, and branch connection were not verified through the Cloudflare API in this pass.

## Recommended separation

Do not silently change the meaning of the existing Worker/config or reuse the shared Preview Queue.

### A. Audit-only staging
- Keep AI and isolated SafetyInterlock only.
- Remove D1, Queue, Vectorize and ETL/RAG routes from this profile.
- Match the audit runbook and route guard exactly.
- Keep `AUDIT_SECRET` out-of-band.
- Remove remote D1 migrations from the audit-only deployment workflow.

### B. Integration staging (separate follow-on)
- Use a distinct Worker name and separately provisioned D1, Vectorize and Queue resources; do not reuse the root Worker's Preview D1/Vectorize bindings.
- Do not attach `aston-global-queue-preview` while it is shared.
- Do not create resources until ownership, billing, consumers, retention, retry policy, and rollback are documented and approved.
- Normalize both ETL ingress paths to one validated schema before enabling a consumer.

## Required gates before any deployment

1. Treat the current D1 as shared with root Wrangler Preview. Inspect all `migrations-staging` files and establish the actual schema/data state before considering any migration. The baseline comment says it expects an empty database, while the live database has 21 tables; do not run it against the current database until compatibility is proven.
2. Verify Workers Builds project settings, connected repository/branch, deploy command, and deploy hooks. Ensure there is no default `wrangler deploy` path that targets production.
3. Reconcile the audit runbook, staging config, route guard, and workflow so they enforce one explicitly named profile.
4. Prove queue isolation using a newly approved, distinct queue; do not reuse the Preview queue.
5. Run tests, typecheck, secret scan, and Wrangler dry-runs; review the diff and rollback plan.
6. Require a separate explicit release decision before dispatching any deployment workflow.

## Change boundary

This branch adds documentation only. It does not alter `wrangler.toml`, `wrangler.staging.toml`, application code, migrations, production resources, Cloudflare bindings, queue consumers, secrets, or deployment settings.


## D1 schema verification — read-only, 2026-11-21

The live D1 database `aston-rag-staging-db` (ID `457d72d6-388b-4dad-bdd0-b32d3e905e00`) was queried through the Cloudflare D1 query API using SELECT against `sqlite_master` only. No business rows were read and no writes were performed.

- The database contains the 21 application tables declared by `migrations-staging/0001_staging_baseline.sql`, plus SQLite/Cloudflare internal tables (`_cf_KV` and `sqlite_sequence`).
- The live table definitions and named indexes inspected match the staging baseline, including:
  - `documents.tenant TEXT NOT NULL DEFAULT ''`;
  - `documents.index_status TEXT DEFAULT 'PENDING_VECTOR'`;
  - `lineage_events.tenant TEXT NOT NULL`;
  - the tenant/status indexes for documents and tenant/object/time index for lineage.
- The later root migration files separately add `documents.tenant`, `documents.index_status`, and `lineage_events.tenant`. Those columns already exist in the live schema. Applying those additive root migrations to this same database would therefore risk duplicate-column failures.
- A read-only lookup found no `d1_migrations` table in `sqlite_master`. The current schema can be compared with the baseline, but the migration ledger/history is not available in this database through that table. Do not infer which migration files Wrangler has recorded or replay them based only on matching schema.
- The baseline's `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements would not reconcile a pre-existing table with a different shape. In this case, the inspected definitions match the baseline, but that does not establish migration history or prove the database is disposable/dedicated.

**Decision:** schema shape is consistent with the staging baseline, but migration provenance is unverified and the database is shared with Preview. Do not run `wrangler d1 migrations apply`, do not apply the root `migrations/` directory to this database, and do not alter the D1 resource as part of audit staging. Any future migration work needs an independently approved, isolated database and a clean migration ledger.

The inspection was metadata-only: no application table rows, secrets, or customer/business records were queried.


## Workers Builds / automatic deployment verification — read-only, 2026-11-21

Cloudflare Workers Builds API was queried for the live production Worker and the proposed audit-staging Worker. No configuration was changed and no build was started.

### Production Worker

- Live script: `agente-os-15-5-hector-zapata`; script tag `9bbbfc0fb267430a8a2aa9c450521965`.
- A Workers Builds configuration **does exist** for this script tag.
- Connected GitHub repository: `adminastonpay-blip/agente-OS-15.5-hector-zapata`, branch `main`.
- Production deploy command: `npx wrangler deploy` from repository root. This uses the root Wrangler configuration, whose Worker name is the production Worker.
- Production trigger includes branch `main`, all paths, and no branch exclusions.
- `auto_build_enabled` is **false** in the retrieved Worker build configuration. This is evidence that automatic builds are currently disabled in that setting, not proof that no other deployment path exists.
- Preview builds are enabled; their deploy command is `npx wrangler preview`, and the same repository connection/build token is referenced.
- The API returned one production build trigger. A read-only deploy-hooks query returned an empty list for the production Worker.

### Proposed audit-staging Worker

- No Workers Builds configuration was found for `aston-os-21x-audit-staging` (Cloudflare returned 404).
- No deploy hooks were returned for that name.
- This is consistent with the earlier live Worker script inventory and direct Worker lookup: the audit-staging Worker is not currently present as a deployed script or configured Workers Build target in this account.

### Release implications

1. There is a configured production Workers Build connection on `main` with the default-root deploy command `npx wrangler deploy`. Although `auto_build_enabled=false` was returned, preserve this as a high-impact deployment path and do not alter it during staging work.
2. The repository runbook's proposed audit-staging branch `feat/audit-staging-harness-21x` is not the production Builds branch. The production trigger is restricted to `main`, but its path include is `*`.
3. The audit-staging deploy workflow remains manual-only, but its remote D1 migration step runs before its dry-run. It must remain undispatched until resource separation and migration provenance are resolved.
4. No staging build configuration, deploy hook, or staging Worker currently exists according to the API queries. Do not create any as part of this investigation.
5. This check did not inspect GitHub repository webhook settings, third-party CI secrets, external deploy services, or user-created API tokens. Therefore it cannot prove that no external deployment mechanism exists.

**Decision:** production deployment configuration is now mapped sufficiently to avoid accidental edits: preserve the existing production Build configuration and its connection to `main`; keep the staging profile unconfigured until a separately approved, isolated design exists. No deployment, build, hook, token, secret, or infrastructure resource was created or modified.

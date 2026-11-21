# ASTON P0 Operational Baseline

**Date:** 2026-11-21  
**Scope:** Read-only evidence collection; no production changes, deploys, or secret reads.

## Verified repository configuration

- Worker name: `agente-os-15-5-hector-zapata`
- Source entrypoint: `src/index.ts`
- Production configuration: `wrangler.toml`
- Staging configuration: `wrangler.staging.toml`
- Production D1 binding: `DB` → `sos-db`
- Preview/staging D1 is a separate database (`aston-rag-staging-db`).
- Preview/staging uses a separate Vectorize index and preview queue.
- Production declares Durable Object bindings for SessionMemory, GraphResolver, Supervisor, AgentNode, SimulationTwin, MissionBrain, SafetyInterlock, and ReplayGuard.
- Production declares the RecoveryWorkflow.


## Live Cloudflare inventory snapshot

Read-only account API inventory returned one Worker matching the ASTON runtime:


- Worker ID/name: `agente-os-15-5-hector-zapata`
- Handlers: `fetch`, `queue`
- Durable Object classes reported: AgentNode, GraphResolver, MissionBrain, ReplayGuard, SafetyInterlock, SessionMemory, SimulationTwin, Supervisor
- RecoveryWorkflow reported with workflow entrypoint and `run`
- `logpush: false`
- `routes: null`
- `deployment_id: ""` in the inventory response


**Interpretation:** the inventory confirms the script and metadata are visible to the account connection. The blank deployment ID, null routes, and disabled Logpush flag are important follow-up signals, but they do not alone prove that the Worker is unavailable or that runtime telemetry is absent. Verify the active version, Workers.dev/custom-domain routing, runtime health, and logs separately before making any availability claim.


## Staging safeguards confirmed

The staging config names a separate Worker and dedicated D1/Vectorize/queue resources. It declares observability and trace sampling. Staging comments indicate the audit secret must be configured before audit endpoint testing. Never copy production data or secrets into staging.


## P0 verification queue

1. **Routing reconciliation:** map the published Shopify endpoint and all internal callers to the currently intended Worker endpoint; remove stale references only after contract tests.
2. **Runtime smoke test:** run anonymous and authenticated health/read-only probes against the actual deployed endpoint; record status, latency, response shape, and timestamp.
3. **Telemetry proof:** verify Workers Logs/Traces are accessible and test correlation IDs, redaction, retention, and alert delivery.
4. **Security baseline:** review auth/tenant guards, allowed origins, rate limits, body-size limits, fail-closed behavior, and exposed routes.
5. **CI evidence:** run type-check, unit/safety/security tests, and staging smoke tests; record command, commit, result, and artifact.

## Operational evidence rule

A component is **verified operational** only when its owner, environment, route, authenticated source, passing test evidence, telemetry, alert/runbook, and rollback/recovery procedure are documented. UI placeholders and configuration declarations are not live operational proof.

## Change boundaries

This baseline is documentation-only. No Worker code, Cloudflare configuration, production secrets, live Shopify theme, or production deployment was changed.


## D1 staging schema reconciliation — read-only snapshot (2026-11-21)

A direct, read-only D1 SQL query against the database configured as `aston-rag-staging-db` returned **21 user tables** (excluding SQLite internals and Cloudflare's `_cf_KV` table). A separate `sqlite_master` check found no `d1_migrations` tracking table.

The Cloudflare database-list metadata reported `num_tables: 0` for this same database, while the SQL catalog query returned the 21 tables. Treat the list metadata as stale/incomplete for schema readiness; the SQL catalog is the direct schema evidence.

The staging repository configuration points to `migrations-staging/0001_staging_baseline.sql`. The live absence of `d1_migrations` does **not** prove that the baseline was never applied; it means Wrangler migration history is not currently evidenced by that conventional table. Do not apply or replay migrations automatically. Reconcile the deployed schema against the checked-in staging baseline and decide on a safe migration-history strategy in a reviewed change.

A separate production naming discrepancy remains: `wrangler.toml` labels database ID `04ef0fcc-cf13-494c-8752-a300d6e6fe90` as `sos-db`, while Cloudflare's account inventory labels that same ID `db1`. This is a metadata/name mismatch, not evidence that the database ID is wrong. Do not rename or rebind it without an approved change.

The Engineering health endpoint now performs a read-only schema catalog query after successful `SELECT 1`. It reports user-table count and whether `d1_migrations` exists separately from connectivity. A schema-inspection failure is diagnostic only and does not falsely mark a successful D1 connectivity probe as failed. No migration, data write, or production change was performed.

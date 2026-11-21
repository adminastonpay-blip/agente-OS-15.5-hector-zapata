# Staging boundary reconciliation — 2026-11-21

## Status

**Investigation only. No Cloudflare resources, bindings, secrets, production files, or deployment settings were changed.**

This report records a configuration/documentation conflict found on `main`. It is not deployment approval.

## Verified findings

1. `docs/AUDIT-STAGING-RUNBOOK.md` describes `aston-os-21x-audit-staging` as an audit-only Worker. It says the profile intentionally has no D1, Queue, R2, Vectorize, Hyperdrive, or session bindings, and says only `GET /`, `GET /health`, and `POST /v1/audit-target` are exposed.
2. `wrangler.staging.toml` names that same Worker and account, but configures:
   - Queue producer and consumer on `aston-global-queue-preview`;
   - D1 binding `DB` to `aston-rag-staging-db`;
   - Vectorize binding `VECTORIZE` to `aston-rag-staging-index`;
   - `AI` and `SafetyInterlock`.
3. `src/audit/staging-route-guard.ts` currently allows `/v1/etl/ingest`, `/v1/rag/ingest`, and `/v1/rag/query` in addition to health and audit paths. This does not match the runbook's audit-only route description.
4. `src/audit/staging-endpoint.ts` deliberately strips DB, ETL_QUEUE, MISSIONS, JOURNAL, VECTORIZE, HYPERDRIVE, SESSION, and AI Gateway only from the *inner chat observation call*. That is a useful local safeguard, but it does not remove those bindings from the Worker environment or prevent the separately exposed ETL/RAG routes from using them.
5. `src/etl-ingest.ts` sends authenticated ETL jobs to `ETL_QUEUE` using the contract `{ tenant, actor, text, source, kind }`. `src/etl.ts` expects tenant, actor and text and writes to D1 and Vectorize.
6. `src/routes/v21.ts` has a separate `/v1/etl/enqueue` producer that sends `{ ...body, tenant, actor, ts }`. It does not enforce the ETL text/source/kind schema at the route before enqueueing.
7. `package.json` contains check and test scripts but no `deploy:staging` script. The expected workflow paths `.github/workflows/ci.yml`, `.github/workflows/ci.yaml`, `.github/workflows/deploy.yml`, and `.github/workflows/staging.yml` were not present at those exact paths; workflow inventory remains to be established from the repository tree/Actions API.
8. The root `wrangler.toml` maps production ETL to `aston-global-queue` and Preview ETL to `aston-global-queue-preview`. The staging config reuses the Preview queue. The Preview queue was previously observed to have active producers/consumer; it must be treated as shared, not as a newly isolated test queue.

## Risk assessment

- **High:** The audit runbook, staging route allowlist, and Wrangler bindings describe different security boundaries.
- **High:** The staging Worker can expose ETL/RAG paths while bound to shared Preview Queue and staging persistence resources, contrary to the audit-only runbook.
- **Medium:** Two ETL enqueue routes produce different message shapes. The generic route can enqueue a message without the required `text` field, causing consumer retries rather than a clean ingress rejection.
- **Unresolved:** The exact deployment workflow and Cloudflare Workers Builds configuration have not yet been reconciled. No deploy should be attempted until these are known.

## Recommended separation

Do not silently choose one profile or repurpose the existing Worker. Establish two explicit deployment profiles, each with a distinct Worker name and reviewed deployment command:

### A. Audit-only staging
- Keep only AI and the isolated SafetyInterlock Durable Object.
- Remove D1, Queue, Vectorize and all ETL/RAG routes from this profile.
- Match the route guard and runbook exactly: health plus secret-protected audit endpoint.
- Keep the existing `AUDIT_SECRET` out-of-band.

### B. Integration staging (separate follow-on)
- Use a distinct Worker name and separately provisioned D1, Vectorize and Queue resources.
- Do not attach `aston-global-queue-preview` while it is shared by other producers/consumers.
- Do not create resources until ownership, billing, consumers, retention, retry policy, and rollback are documented and approved.
- Normalize both ETL ingress paths to one validated schema before enabling a consumer.

## Required gates before any deployment

1. Inventory repository workflow files and Cloudflare Workers Builds settings; establish the exact deploy trigger and config path.
2. Verify the active Preview queue's producer/consumer associations and prove no existing workload depends on the proposed integration.
3. Agree on whether the existing `aston-os-21x-audit-staging` name is reserved for audit-only. Do not change its meaning in place.
4. Prepare separate configs and tests on an isolated branch; run targeted tests, typecheck, secret scan, and Wrangler dry-runs.
5. Review the diff and rollback plan. Deployment requires a separate explicit release decision.

## Change boundary

This investigation branch adds documentation only. It does not alter `wrangler.toml`, `wrangler.staging.toml`, application code, migrations, production resources, Cloudflare bindings, queue consumers, or secrets.

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
4. The live account's Worker script inventory returned only `agente-os-15-5-hector-zapata`; a direct GET for `aston-os-21x-audit-staging` returned Cloudflare 404 / Worker does not exist. The staging config is therefore not evidence of a deployed Worker.
5. `src/audit/staging-route-guard.ts` allows health, audit, `/v1/etl/ingest`, `/v1/rag/ingest`, and `/v1/rag/query`. The runbook describes a narrower audit-only allowlist. The guard itself does not allow every application route, but ETL/RAG are explicitly enabled.
6. `src/index.ts` exposes a separate `/v1/etl/enqueue` path in the v21 router. That path sends `{ ...body, tenant, actor, ts }` without validating the ETL `text` contract. `src/etl-ingest.ts` sends `{ tenant, actor, text, source, kind }` after Access identity/role validation. `src/etl.ts` requires tenant, actor and text and retries failures. The producer contracts are inconsistent.
7. There are three relevant GitHub workflows:
   - `.github/workflows/cloudflare-ci.yml`: pull-request CI; checks and Wrangler dry-runs for production and staging config only.
   - `.github/workflows/audit-staging-validation.yml`: tests/typecheck and staging dry-run; its push trigger names the historical branch `feat/audit-staging-harness-21x`.
   - `.github/workflows/deploy-isolated-staging.yml`: manual `workflow_dispatch` only, requiring exact input `DEPLOY-STAGING`.
8. The manual deploy workflow is high impact even though manually gated: after checking Cloudflare and audit secrets, it runs remote D1 migrations **before** the dry-run, deploys `wrangler.staging.toml`, and installs `AUDIT_SECRET`. The confirmation string is not a substitute for independent release review. Do not dispatch this workflow during the current investigation.
9. `docs/AUDIT-STAGING-RUNBOOK.md` also references Workers Builds configuration for branch `feat/audit-staging-harness-21x` and a deploy command. The live Cloudflare API confirms no `aston-os-21x-audit-staging` Worker script, but Workers Builds project settings were not yet verified. Do not infer that no connected build/deploy project exists solely from the Worker script listing.

## Risk assessment

- **Critical release blocker:** The manual staging deploy workflow runs `wrangler d1 migrations apply ... --remote` before deployment. The exact migration contents and resulting schema impact must be reviewed before anyone dispatches it.
- **High:** The audit-only runbook and actual staging Wrangler bindings/route allowlist do not describe the same security boundary.
- **High:** The configured Preview Queue is shared by 11 producers and consumed by the main Worker. Attaching the staging Worker as another consumer or sending test messages could affect live processing.
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
- Use a distinct Worker name and separately provisioned D1, Vectorize and Queue resources.
- Do not attach `aston-global-queue-preview` while it is shared.
- Do not create resources until ownership, billing, consumers, retention, retry policy, and rollback are documented and approved.
- Normalize both ETL ingress paths to one validated schema before enabling a consumer.

## Required gates before any deployment

1. Inspect all `migrations-staging` files and prove whether the remote D1 migration step is additive, idempotent, and scoped only to the intended staging database.
2. Verify Workers Builds project settings, connected repository/branch, deploy command, and deploy hooks. Ensure there is no default `wrangler deploy` path that targets production.
3. Reconcile the audit runbook, staging config, route guard, and workflow so they enforce one explicitly named profile.
4. Prove queue isolation using a newly approved, distinct queue; do not reuse the Preview queue.
5. Run tests, typecheck, secret scan, and Wrangler dry-runs; review the diff and rollback plan.
6. Require a separate explicit release decision before dispatching any deployment workflow.

## Change boundary

This branch adds documentation only. It does not alter `wrangler.toml`, `wrangler.staging.toml`, application code, migrations, production resources, Cloudflare bindings, queue consumers, secrets, or deployment settings.

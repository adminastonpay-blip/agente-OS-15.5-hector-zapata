# AST-001 integration rebase — audit findings

Date: 2026-11-19
Base: current main at 81cd78862f581dc9e2bd0ccb7aebda6778806d9c
Branch: feat/ast-001-integration-rebase-2026-11-19
Status: DRAFT — source reconciliation started; runtime changes not yet applied or validated.

## Confirmed GitHub state

- PR #34 (RAG tenant isolation): OPEN; head 1cf12411c200c2c65edc707f800b0072d54435d3; mergeable according to GitHub metadata.
- PR #35 (D1 migration ordering): merged into the PR #34 work branch; its base-documents migration is present in the #34 diff.
- PR #36 (PII HMAC fail-closed): OPEN; head 33270659502ecc15df40ebb9451a1d6dbaa86d87; GitHub reports mergeable=false.
- PR #37 (Lineage tenant isolation): OPEN; head 03b3a01e29e879edfff8b1f77482c5bda800b7e1; GitHub reports mergeable=false.
- Previous integration branch feat/ast-001-rag-lineage-tenant-integration is 88 commits ahead and 88 behind current main (diverged); it must not be used as the new integration base.
- Current main SHA at rebase start: 81cd78862f581dc9e2bd0ccb7aebda6778806d9c.

## Concrete conflicts and integration risks found in source diffs

1. Both PR #36 and PR #37 modify package.json scripts/test:security. Their changes must be composed, not selected wholesale.
2. PR #36 and PR #37 both modify src/routes/v21.ts. PII fail-closed and tenant-scoped lineage must be merged into one coherent route implementation.
3. PR #37 adds documents.tenant in schema.sql and its migration, while PR #34/#35 also adds documents.tenant via the RAG migration sequence. Applying both ALTERs would fail with a duplicate-column error.
4. PR #37 changes lineage_events schema and emitLineage call sites to require tenant. Every caller must be inventoried and supplied with authenticated tenant context.
5. PR #37's ETL consumer rejects jobs without job.tenant and stores tenant in Vectorize/D1, but this alone does not prove /v1/etl/enqueue derives tenant from the authenticated identity. The producer path must be traced and fixed before approval.
6. The RAG branch's stated contract reads decision context from metadata.text. Other ETL/cron changes in the Lineage branch use metadata.chunk. All producers, consumers and tests must converge on one field contract.
7. PR #36 requires PII_HMAC_SECRET >= 32 characters and returns 503 otherwise. This branch must not set, generate, expose, or change that production secret. Deployment readiness must be checked separately without revealing its value.
8. PR #34 explicitly says real staging D1 migration and real Vectorize tenant-isolation tests are still required before merge. CI/dry-run alone is not equivalent.

## Required implementation order

1. Rebase from current main (this branch does so); retain all current main changes.
2. Compose package.json scripts and src/routes/v21.ts changes from #34/#36/#37.
3. Reconcile schema.sql and migrations so documents.tenant is added exactly once and lineage_events.tenant is consistent for fresh and upgraded databases.
4. Trace /v1/etl/enqueue through the queue producer and consumer. Tenant authority must come from authenticated server-side identity; reject caller-supplied tenant overrides.
5. Normalize Vectorize text metadata across ingest, ETL, cron re-embedding, /v1/rag/query, and /v1/decide.
6. Inventory every emitLineage call; add trusted tenant at every call site and fail closed when absent.
7. Add/retain Alpha/Beta cross-tenant tests for vectors, D1 documents, lineage reads/writes, enqueue authority, and missing tenant.
8. Run CI and Cloudflare Preview on this exact branch SHA; inspect any failed logs.
9. Only after CI passes, conduct isolated staging D1 migration and real Vectorize tests. No production migration/deployment in this integration task.

## Safety boundary

This branch is a review workspace only. No PR has been merged. No production Worker, D1 database, Vectorize index, binding, secret, or Cloudflare resource has been changed. No migration has been executed. Do not merge or deploy until the tests and independent review above pass.

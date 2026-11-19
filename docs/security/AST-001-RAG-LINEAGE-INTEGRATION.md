# AST-001 — RAG + Lineage tenant isolation integration

Status: **DRAFT / IMPLEMENTATION IN PROGRESS / NOT VALIDATED**
Date: 2026-11-19
Target: `main`
Integration branch: `feat/ast-001-rag-lineage-tenant-integration`

## Purpose

Reconcile the RAG tenant-isolation work from PR #34 (including the D1 migration-order correction merged through PR #35) with the lineage tenant-isolation work from PR #37. Preserve both security objectives while producing one coherent runtime, schema, migration sequence, and regression suite.

This document is a tracking contract. It does not claim that the runtime integration is complete or validated.

## Source PR state checked for this integration

- PR #34, `feat/rag-tenant-isolation`, head `1cf12411c200c2c65edc707f800b0072d54435d3`: open; RAG namespace/metadata filtering, indexing states, and RAG tests.
- PR #35, `fix/rag-d1-migration-order`, head `58e7e6845e8be382b870c8c71127a7ac15a49590`: merged into the PR #34 branch; adds the base `documents` migration needed for empty D1 and preserves additive migration order.
- PR #37, `fix/lineage-tenant-isolation`, head `03b3a01e29e879edfff8b1f77482c5bda800b7e1`: open; tenant-scoped lineage writes and reads plus producer/consumer propagation.

The PR #37 source branch has Cloudflare Preview build failures reported in its PR discussion. Those failures are not treated as proof of a code defect until their logs are examined, but they prevent claiming a successful Preview validation.

## Integration invariants

1. Tenant ownership is derived only from authenticated server-side identity or a trusted server-side queue envelope. Never accept a caller-selected tenant as authority.
2. RAG upsert and query must use the same authenticated tenant namespace and tenant metadata filter. Apply this to both `/v1/rag/query` and `/v1/decide`.
3. Every lineage write must include a non-empty authoritative tenant; every lineage read must constrain both tenant and object ID.
4. Legacy rows/vectors without authoritative tenant ownership remain inaccessible to tenant-scoped reads and automated re-embedding. Do not infer ownership.
5. `documents.tenant` must be added exactly once in the canonical migration sequence. `lineage_events.tenant` must be represented consistently in fresh schema and upgrade migration.
6. RAG and ETL Vectorize metadata must use one documented text field contract. The current source branches disagree between `metadata.text` and `metadata.chunk`.
7. An ETL consumer requiring `job.tenant` is insufficient by itself: every enqueue producer must derive and bind that tenant from authenticated identity before a queue message is emitted.

## Known integration work / blockers

- Merge the two `src/routes/v21.ts` change sets without losing RAG namespace/filter behavior or tenant-scoped lineage reads/writes.
- Port the `emitLineage` tenant argument to every producer changed by PR #37 and inventory all other call sites. Missing tenant must fail closed.
- Trace `/v1/etl/enqueue` and every queue producer. The PR #37 diff validates `job.tenant` in the consumer but does not establish that the enqueue route derives it from authenticated identity.
- Normalize Vectorize metadata to one field (prefer the RAG branch's `text` contract unless source-wide usage proves another canonical choice); update ingestion, ETL, cron re-embedding, retrieval, and tests together.
- Reconcile `schema.sql` with the existing #34/#35 `documents` migrations and the new lineage migration. Avoid a second `ALTER TABLE documents ADD COLUMN tenant`.
- Confirm migration behavior from both a genuinely empty database and an existing database at the supported migration baseline. Do not execute migrations against Cloudflare from this PR.
- Review Vectorize namespace/filter types and behavior against the exact installed Workers types/API; do not rely only on casts or mocks.
- Inspect and resolve the Cloudflare Preview failures reported on PR #37 before treating the combined branch as deployable.

## Required tests before this PR can leave draft

- Alpha cannot retrieve Beta vectors, and Beta cannot retrieve Alpha vectors.
- Missing/invalid tenant is rejected for RAG ingest, RAG query, decide context, lineage write, lineage read, and ETL enqueue.
- Identical object IDs across tenants remain isolated in lineage.
- Queue messages cannot substitute a tenant supplied by the external caller.
- RAG and ETL metadata are mutually readable under the canonical text contract.
- Legacy rows/vectors with empty or absent tenant remain excluded.
- D1 migration tests cover empty schema creation and the supported existing-schema upgrade path, with no duplicate column operation.
- All `emitLineage` call sites are covered by strict TypeScript and targeted tests.
- CI is green on the exact integration branch SHA. Preview dry-run/build is not a substitute for real staging D1/Vectorize isolation tests.

## Safety boundaries

- No PR is merged by this work.
- No Cloudflare resource, binding, secret, Worker, or production setting is changed.
- No D1 migration is executed against Cloudflare.
- No production deployment is performed.
- Historical tenant ownership is not guessed or backfilled.
- Keep this PR draft until the above checks are complete and independently reviewed.

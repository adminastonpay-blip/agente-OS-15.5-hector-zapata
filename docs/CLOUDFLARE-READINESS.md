# Cloudflare readiness — ASTON OS

Inspection date: 2026-11-17  
Scope: read-only account inspection plus repository review. No Cloudflare resources were created, updated, deleted, or deployed.

## Confirmed blockers and gaps

| Area | Repository expectation | Cloudflare observation | Safe action |
|---|---|---|---|
| Production D1 | `sos-db`, ID `04ef0fcc-cf13-494c-8752-a300d6e6fe90` | GET by ID returned 404 / error 7404 | Confirm intended DB ID and schema. Do not bind the empty `db1` database as a guess. |
| R2 | Production code supports `JOURNAL` and audit code supports `AUDIT_ARCHIVE` | R2 API returned error 10042; no verified bucket available | Enable R2 / verify bucket names, then add bindings deliberately. |
| Queue | Producer `ETL_QUEUE` targets `aston-global-queue` | Queue exists, but has zero producers and zero consumers | Add a tested consumer and producer path before claiming ETL/recovery is active. |
| Queue handler | `src/queue/consumer.ts` and `src/etl.ts` exist | Neither is wired into the Worker default export in the inspected source | Implement explicit `queue()` handler and route messages by schema before attaching a consumer. |
| AI Gateway | `AI_GATEWAY_ID = sovereign-gateway` | Gateway listing was empty | Runtime has direct-AI fallback. Verify the Gateway ID before relying on gateway features. |
| Vectorize | ETL requires `VECTORIZE` | No binding configured in `wrangler.toml` | Keep ETL marked unavailable until an index is provisioned and bound. |
| Workflow journal | Recovery workflow requires `JOURNAL` | No production `JOURNAL` binding configured | Do not start RecoveryWorkflow until R2 journal binding and failure/retry tests exist. |
| Durable Objects | Seven classes are exported and bound declaratively | Account namespace listing was empty at inspection time | Do not manually create or migrate namespaces based on this listing alone; validate after a controlled staging deploy. |

## Staging changes made in this PR
- Removed the unverified R2 bucket binding from `wrangler.staging.toml`. The staging audit endpoint can still exercise the Safety Durable Object and Workers AI, but external R2 checkpoint anchoring is not tested.
- Enabled Worker traces in addition to observability logs.
- No production configuration, secrets, DNS, routes, resources, or deployed versions were modified.

## Required order before production release
1. Identify the correct production D1 database and inspect its tables/migrations.
2. Enable R2 and choose separate staging and production buckets with the required retention/immutability controls.
3. Implement and test Queue producer/consumer wiring and schema validation.
4. Provision Vectorize only if semantic ETL/RAG is in scope; bind it explicitly.
5. Confirm AI Gateway existence and policy configuration, or remove the stale ID and rely on direct Workers AI.
6. Validate Durable Object bindings through an isolated staging deployment and runtime smoke tests.
7. Only then schedule a production change with a reviewed rollback plan.

## Important distinction
Wrangler `--dry-run` passing means the bundle/configuration can be built. It does not prove that a referenced D1 database, R2 bucket, Queue consumer, AI Gateway, or runtime binding is live and healthy.

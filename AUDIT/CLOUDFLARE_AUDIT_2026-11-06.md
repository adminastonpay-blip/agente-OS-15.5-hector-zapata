# Cloudflare / GitHub audit — 2026-11-06

Repository: `adminastonpay-blip/agente-OS-15.5-hector-zapata`
Audited ref: `main` (read-only baseline)
Remediation ref: `audit/cloudflare-hardening-2026-11-06`

## Executive result

The repository is a Cloudflare Workers TypeScript project, but the checked-in configuration and code are not yet demonstrably production-ready. Several declared capabilities are not wired in Wrangler, and there are configuration/version inconsistencies. No production deployment was performed.

## Verified findings

### Critical — authorization helper fails open
- Baseline `src/lib/identity.ts` returned `true` from `requireAdmin` whenever `API_KEY` was absent.
- This makes the helper grant admin authorization during missing-secret/bootstrap conditions.
- Remediation on this branch: changed the helper to fail closed for `public` identities and require an explicit `admin` or `executor` role from a non-public identity.
- Still required: inspect every privileged route and prove each one calls the authorization helper before reading or mutating protected state.

### High — declared capabilities are not all bound
- `src/types.ts` declares optional `VECTORIZE`, `JOURNAL`, `MISSIONS`, and `HYPERDRIVE` bindings.
- The checked-in `wrangler.toml` contains AI, D1, a queue producer, and seven Durable Object bindings, but no Vectorize, R2 bucket, Hyperdrive, queue consumer, or Workflow binding.
- `src/workflows/recovery.ts` dereferences `JOURNAL`, AI, and PII secret bindings as if available. Its workflow is not declared in the inspected Wrangler configuration.
- Do not add placeholder resource IDs. Create or confirm the real Cloudflare resources and use distinct IDs/names for staging and production before wiring them.

### High — queue producer mismatch
- README setup refers to queues `etl-pipeline`, `etl-dlq`, `recovery.missions`, and `recovery-dlq`.
- Wrangler currently binds `ETL_QUEUE` to `aston-global-queue`.
- The inspected queue consumer expects `SUPERVISOR` and is not registered as a Wrangler queue consumer.
- Reconcile queue names, producers, consumers, retry/DLQ behavior and ownership before enabling asynchronous processing.

### High — tenant/session isolation needs end-to-end verification
- The Worker entrypoint uses a session Durable Object keyed from the supplied session ID. The inspected call site does not include tenant identity in that key.
- Public identity accepts `X-Aston-Tenant`; that header is client-controlled unless validated against an authenticated identity.
- Review all D1 queries, Durable Object names, Vectorize metadata filters, object links, caches, and journal keys for tenant scoping. A per-route review is still pending.

### Medium — version drift
- `package.json` version: `21.4.1`.
- `src/index.ts` runtime version: `21.6.1-envelope`.
- `wrangler.toml` `DEPLOY_PROFILE`: `21.6.2-envelope`.
- README identifies the product as Agente OS 15.5.
- Select one canonical release/version policy and generate or validate all exposed version fields from it.

### Medium — type-check coverage gap
- `tsconfig.json` excludes `src/workflows/**`.
- This means the normal TypeScript check does not cover workflow source, including the recovery workflow's optional-binding assumptions.
- Expand coverage after fixing workflow types and binding declarations; do not suppress workflow errors by excluding the directory.

### Medium — reproducibility and CI
- `package.json` has no test script and no lockfile was found at the repository root.
- No GitHub Actions workflow was found at the conventional deploy/CI paths inspected.
- A non-production CI workflow is added on this remediation branch to install dependencies, run the TypeScript check, and run Wrangler's dry-run bundle validation. Its first GitHub Actions result must be reviewed before merging.

### Medium — permissive CORS
- The Worker entrypoint currently sends `Access-Control-Allow-Origin: *`.
- Confirm whether the API is intentionally public. If browser clients use credentials or privileged endpoints, replace wildcard CORS with an explicit origin allowlist and validate `Origin`; CORS is not a substitute for authentication.

## Cloudflare resource inventory from checked-in config

| Resource | Wrangler config | Code/type references | Status |
|---|---|---|---|
| Workers AI | `AI` | required by `Env` | Bound |
| D1 | `DB` | optional in `Env` | Bound |
| Durable Objects | SESSION, GRAPH, SUPERVISOR, AGENT, SIMULATION, MISSION, SAFETY | classes exported by entrypoint | Bound; migrations v1/v2 present |
| Queue producer | `ETL_QUEUE` -> `aston-global-queue` | ETL queue optional | Bound; naming/consumer mismatch |
| Vectorize | — | `VECTORIZE` | Not bound |
| R2 | — | `JOURNAL` | Not bound |
| Hyperdrive | — | `HYPERDRIVE` | Not bound |
| Workflows | — | `RecoveryWorkflow` source | Not bound/declared |
| Queue consumer | — | consumer source exists | Not registered |

## Remediation order

1. Verify authorization on every privileged route and fail closed.
2. Complete tenant isolation review across sessions, D1, DO, queues, vector index and R2.
3. Reconcile actual Cloudflare resources with Wrangler bindings and environment-specific IDs.
4. Correct queue producer/consumer/DLQ topology.
5. Register Workflows only after required bindings and approval semantics are safe.
6. Include workflow files in type-checking and add tests for auth, tenant isolation, risk gates and migrations.
7. Pin dependencies and commit a lockfile; run dependency/security scanning.
8. Validate preview deploy and runtime smoke tests before any production rollout.

## Safety boundary

This branch is isolated from `main`. No production deployment, secret rotation, resource creation/deletion, migration execution, or binding removal was performed. Missing Cloudflare account-side resource IDs and secret values cannot be inferred from GitHub source.

# ASTON OS × Cloudflare infrastructure map

Honest positioning: Aston differentiates on **governance** (ontology, measured decisions, compliance-as-code, agent trust), not on “having agents” (now commodity via Cloudflare OS).

## Close gaps vs Palantir-class platforms

| Capability | Cloudflare product | Aston use |
|------------|-------------------|----------|
| Branching / what-if | **Durable Objects** + SimulationTwin | `/v1/simulation` |
| Agent runtime | Workers + AgentNode + Supervisor | `/v1/swarm/plan` |
| Policy / HITL | SafetyInterlock | `/v1/safety/evaluate`, defense approve |
| Structured knowledge | D1 + ontology | `/v1/ontology/*` |
| Semantic recall | Vectorize + Workers AI | `/v1/rag/*` |
| Audit trail | D1 lineage + R2 journal | `/v1/lineage`, `/v1/audit` |
| Edge scale | Anycast Workers | single Worker URL |

## Advantage Palantir does not natively own

| Capability | Cloudflare product | Aston wedge |
|------------|-------------------|-------------|
| Micro-tool factory | Dynamic Workers (future) + recipes today | `/v1/factory/*` |
| Agent identity + budget | **Wallets + x402** | `/v1/economy/*`, 402 on `/v1/factory/run` |
| Trust passport | WebCrypto PQC + D1 | `/v1/reputation/*` |
| Code certify | Safety + static/AI scan | `/v1/certify` |
| Decision lakehouse | **Pipelines, R2 Data Catalog, R2 SQL** | JOURNAL paths + ledger tables |
| Multi-tenant isolation | **Workers for Platforms** | `tenantKey()` today; WfP later |
| Data residency | **Data Localization Suite** + D1/R2 jurisdictions | out of band config |

## Explicit non-goals

- **Air-gapped / DORA-class disconnected ops** — not on Cloudflare public edge. Do not position Aston there.
- “Restart the global network” — not a product claim.

## Build order (max impact)

1. **Stable deploy** (migration tags aligned).
2. **R2 JOURNAL** binding → artifacts + decision ledger objects.
3. **Vectorize** → RAG production.
4. Unify **Passport + Decision Ledger** (x402 + policy + lineage).
5. Dynamic Workers dispatch for `code_preview` (account feature).
6. Workers for Platforms + localization for sovereign tenants.

## Bindings checklist

| Binding | Status in code |
|---------|----------------|
| AI, SESSION, GRAPH, SUPERVISOR, AGENT, SIMULATION, MISSION, SAFETY | Expected |
| DB (D1) | Optional soft-fail |
| ETL_QUEUE | Optional |
| VECTORIZE | Optional |
| JOURNAL (R2) | Optional — use for artifacts/catalog |
| HYPERDRIVE | Optional |
| Workflows / Dynamic Workers / Wallets | Not bound yet — design only |

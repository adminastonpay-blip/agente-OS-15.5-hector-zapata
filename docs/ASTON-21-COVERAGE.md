# ASTON OS 21.0 — Coverage vs PDF (edge deploy)

Worker: `agente-os-15-5-hector-zapata`  
Version: `21.0.0-edge`

## Always on (no extra Cloudflare resources)

| PDF pillar | Status | Routes / mechanism |
|---|---|---|
| Chat + session memory | Live | `/chat`, `/v1/chat`, DO `SESSION` |
| Solve / decide | Live | `/v1/solve`, `/v1/decide` |
| TTS / voice | Live | `/v1/tts`, `/v1/voice` |
| Graph resolver | Live | DO `GRAPH`, `/v1/graph/*` |
| Supervisor swarm | Live | DO `SUPERVISOR`, `/v1/swarm/plan` |
| Agent nodes | Live | DO `AGENT` |
| Simulation twin | Live | DO `SIMULATION`, `/v1/simulation` |
| Mission brain | Live | DO `MISSION`, `/v1/mission` |
| Safety interlock | Live | DO `SAFETY`, `/v1/safety/evaluate` |
| PII mask | Live | `/v1/pii/mask` |
| Capabilities map | Live | `/v1/capabilities` |

## Needs dashboard bindings (code ready, soft-fail until bound)

| Resource | Unlock |
|---|---|
| D1 `DB` + `schema.sql` | Ontology writes, lineage, swarm task audit, RAG metadata |
| Vectorize `VECTORIZE` | Semantic RAG ingest/query |
| R2 `JOURNAL` | Immutable audit journal |
| Queues `ETL_QUEUE` / `MISSIONS` | Async ETL & recovery |
| Hyperdrive | Bitemporal cascade (Postgres) |
| Access / `API_KEY` | Non-public identity |

## Intentionally not claimed as production-certified

Per roadmap WP-12: no FedRAMP/SOC2 claim, no Palantir parity claim, no physical-AI certification by schema alone.

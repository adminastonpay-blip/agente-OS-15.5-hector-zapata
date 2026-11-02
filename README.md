# Agente OS 15.5 - Hector Zapata

**Sovereign Decision OS** — Sistema de decisión soberano basado en Cloudflare Workers.

## Características

- **RAG Semántico** con Vectorize + Session Durable Object + AI Gateway
- **Ontología bitemporal** (objetos + links) con GraphResolver DO
- **Linaje extremo a extremo** (D1 + BFS)
- **Enjambre de agentes** (Supervisor + AgentNode DOs)
- **Decision Twin** (SimulationTwin DO efímero)
- **Recovery logístico** dual (Queue + Workflow con human-in-the-loop)
- **PII masking** con HMAC + clearance ABAC
- **Criptografía post-cuántica** (ML-DSA / ML-KEM)
- **Journal inmutable** en R2

## Estructura

```
agente-os-15.5/
├── wrangler.toml
├── schema.sql
├── src/
│   ├── index.ts
│   ├── auth.ts
│   ├── pii.ts
│   ├── lineage.ts
│   ├── ontology.ts
│   ├── etl.ts
│   ├── types.ts
│   ├── crypto/pq.ts
│   ├── lib/ai.ts
│   ├── do/
│   │   ├── session.ts
│   │   ├── graph-do.ts
│   │   ├── supervisor.ts
│   │   ├── agent-node.ts
│   │   ├── simulation.ts
│   │   └── mission-brain.ts
│   ├── workflows/recovery.ts
│   └── queue/consumer.ts
```

## Setup rápido

```bash
# 1) Crear recursos
wrangler queues create etl-pipeline
wrangler queues create etl-dlq
wrangler queues create recovery.missions
wrangler queues create recovery-dlq
wrangler d1 create sos-db
wrangler r2 bucket create sos-journal
wrangler vectorize create knowledge-base --dimensions=1024 --metric=cosine
wrangler hyperdrive create sos-graph --connection-string="postgres://..."

# 2) Copiar IDs a wrangler.toml (d1 database_id, hyperdrive id)

# 3) Aplicar schema
wrangler d1 execute sos-db --file=./schema.sql --remote

# 4) Secretos
wrangler secret put API_KEY
wrangler secret put PII_HMAC_SECRET
wrangler secret put CF_API_TOKEN   # opcional

# 5) Configurar AI Gateway en dashboard (ruta "sovereign-gateway")

# 6) Deploy
wrangler deploy
```

## Endpoints principales

| Endpoint | Descripción |
|----------|-------------|
| `POST /etl/ingest` | Pipelines asíncronos + PII masking |
| `POST /chat` | RAG semántico |
| `POST /ontology/types\|objects\|links` | Ontología |
| `GET /ontology/neighbors/:id` / `path` | Grafo tiempo real |
| `POST /ontology/impact` | Impacto en cascada bitemporal |
| `GET /lineage/:id` | Linaje |
| `POST /swarm/run` | Enjambre autónomo |
| `POST /simulation` + `/apply` `/evaluate` `/commit` | Decision Twin |
| `POST /ingest-failure` | Recovery logístico |
| `GET /mission/:id` | Journal de misión |
| `POST /workflow/:id/approve` | Human-in-the-loop |
| `GET /audit` | Auditoría |

---

**Agente OS 15.5** · Hector Zapata · 2026

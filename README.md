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
- **MCP Governance Server** (Océano Azul) — Árbitro neutral multi-vendor

## Estructura

```
agente-os-15.5/
├── package.json
├── tsconfig.json
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
│   ├── mcp/
│   │   └── governance.ts      ← NUEVO: MCP Governance Server
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
| **`GET/POST /mcp`** | **MCP Governance Server (Océano Azul)** |

## MCP Governance Server

Endpoint: `https://<tu-worker>.workers.dev/mcp`

Expone las capacidades soberanas de Aston OS como **tools MCP** para que cualquier cliente (Claude, Cursor, Windsurf, agentes de terceros) pueda usar el sistema como **árbitro neutral de gobernanza**.

### Tools disponibles

| Tool | Descripción | Clearance / Role |
|------|-------------|------------------|
| `cascade_impact` | Impacto en cascada bitemporal | Cualquiera autenticado |
| `get_lineage` | Árbol de provenance | Cualquiera autenticado |
| `find_objects` | Búsqueda por propiedad | Cualquiera autenticado |
| `create_object` | Crear objeto en ontología | executor/admin + confidential+ |
| `create_link` | Crear relación | executor/admin |
| `run_simulation` | Iniciar Decision Twin | Cualquiera autenticado |
| `apply_simulation_delta` | Aplicar cambio en simulación | Cualquiera autenticado |
| `evaluate_simulation` | Evaluar impacto/riesgo | Cualquiera autenticado |
| `audit_log` | Últimas entradas de auditoría | Cualquiera autenticado |
| `swarm_plan` | Planificar y ejecutar enjambre | Cualquiera autenticado |

Todas las llamadas generan **lineage automático**.

### Ejemplo de conexión (Claude / Cursor)

```
MCP Server URL: https://agente-os-15.5.<account>.workers.dev/mcp
Authorization: Bearer <API_KEY>
```

---

**Agente OS 15.5** · Hector Zapata · 2026 · MCP Governance Server

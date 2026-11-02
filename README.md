# Agente OS 15.5 - Hector Zapata

**Sovereign Decision OS** — Sistema de decisión soberano basado en Cloudflare Workers.

## Características

- **RAG Semántico** con Vectorize + Session Durable Object + AI Gateway
- **Ontología bitemporal** (objetos + links) con GraphResolver DO
- **Linaje extremo a extremo** (D1 + BFS)
- **Enjambre de agentes** (Supervisor + AgentNode DOs) con **SafetyInterlock**
- **Decision Twin** (SimulationTwin DO efímero)
- **Recovery logístico** dual (Queue + Workflow con human-in-the-loop)
- **PII masking** con HMAC + clearance ABAC
- **Criptografía post-cuántica** (ML-DSA / ML-KEM)
- **Journal inmutable** en R2
- **MCP Governance Server** (Océano Azul) — Árbitro neutral multi-vendor
- **SafetyInterlock + Sandbox** — Política de riesgo + human-in-the-loop
- **Certified Extraction Engine (CEE)** — Clairic + certificados firmados PQC

## Estructura

```
agente-os-15.5/
├── package.json
├── tsconfig.json
├── wrangler.toml
├── schema.sql
├── src/
│   ├── index.ts
│   ├── auth.ts / pii.ts / lineage.ts / ontology.ts / etl.ts / types.ts
│   ├── crypto/pq.ts
│   ├── lib/ai.ts
│   ├── mcp/governance.ts
│   ├── safety/policy.ts
│   ├── extraction/
│   │   ├── types.ts
│   │   ├── clairic.ts
│   │   └── certificate.ts
│   ├── do/
│   │   ├── session.ts / graph-do.ts / supervisor.ts / agent-node.ts
│   │   ├── simulation.ts / mission-brain.ts / safety-interlock.ts
│   ├── workflows/
│   │   ├── recovery.ts
│   │   └── certified-extraction.ts
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

# 2) Copiar IDs a wrangler.toml
# 3) Aplicar schema
wrangler d1 execute sos-db --file=./schema.sql --remote

# 4) Secretos
wrangler secret put API_KEY
wrangler secret put PII_HMAC_SECRET
wrangler secret put CF_API_TOKEN   # opcional

# 5) AI Gateway + Deploy
wrangler deploy
```

## Endpoints principales

| Endpoint | Descripción |
|----------|-------------|
| `POST /etl/ingest` | Pipelines asíncronos + PII masking |
| `POST /chat` | RAG semántico |
| `POST /ontology/*` | Ontología + impacto |
| `GET /lineage/:id` | Linaje |
| `POST /swarm/run` | Enjambre (con SafetyInterlock) |
| `POST /simulation/*` | Decision Twin |
| `POST /ingest-failure` | Recovery logístico |
| `GET/POST /mcp` | **MCP Governance Server** |
| `POST /safety/evaluate` | Evaluar acción (allow/deny/require_approval) |
| `GET /safety/pending` | Aprobaciones pendientes |
| `POST /safety/decide` | Aprobar/rechazar |
| `POST /extraction/certify` | **CEE — extracción certificada Clairic** |
| `POST /extraction/workflow/:id/review` | Revisión humana de campos |
| `GET /extraction/certificates` | Listar certificados |
| `GET /audit` | Auditoría |

## MCP Tools

`cascade_impact`, `get_lineage`, `find_objects`, `create_object`, `create_link`, `run_simulation`, `apply_simulation_delta`, `evaluate_simulation`, `audit_log`, `swarm_plan`, `safety_evaluate`, `safety_pending`, `extraction_certify`

## Certified Extraction Engine

```bash
POST /extraction/certify
{
  "documentId": "inv_001",
  "text": "Factura ... Total: 12450 ... Vence: 2026-12-01",
  "schema": [
    { "name": "invoice_total", "type": "number", "min_confidence": 0.95 },
    { "name": "due_date", "type": "date" }
  ]
}
```

Clairic → confidence + p_null → certificado ML-DSA → ontología + R2 + lineage.

---

**Agente OS 15.5** · Hector Zapata · 2026

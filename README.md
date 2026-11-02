# Agente OS 15.5 - Hector Zapata

**Sovereign Decision OS** — Sistema de decisión soberano basado en Cloudflare Workers.

Incluye:
- Agente semántico + RAG (Vectorize + AI Gateway)
- Ontología + Grafo (D1 + Durable Objects)
- Linaje de datos
- Enjambre de agentes (Supervisor + AgentNode)
- Decision Twin / Simulaciones
- Recovery logístico (Queues + Workflows)
- Criptografía post-cuántica (preparada)
- Gobernanza ABAC + PII masking

## Estructura

```
src/
├── index.ts
├── auth.ts
├── pii.ts
├── lineage.ts
├── ontology.ts
├── etl.ts
├── types.ts
├── crypto/pq.ts
├── lib/ai.ts
├── do/
│   ├── session.ts
│   ├── graph-do.ts
│   ├── supervisor.ts
│   ├── agent-node.ts
│   ├── simulation.ts
│   └── mission-brain.ts
├── workflows/recovery.ts
└── queue/consumer.ts
```

## Deploy rápido

1. Crear recursos (queues, D1, R2, Vectorize, Hyperdrive)
2. Actualizar IDs en `wrangler.toml`
3. `wrangler d1 execute sos-db --file=./schema.sql --remote`
4. Secrets: `API_KEY`, `PII_HMAC_SECRET`, `CF_API_TOKEN`
5. `wrangler deploy`

---
Basado en Aston OS / Sovereign Decision OS.

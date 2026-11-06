# Decision Provenance Layer — ASTON OS IP core

> Automated decisions that are **explainable, reproducible, auditable, and reversible**.

## Endpoints

| Method | Path | Purpose |
|--------|------|--------|
| POST | `/v1/provenance/decide` | Record decision package + certificate |
| POST | `/v1/provenance/replay` | Re-run prompts; compare outcome hashes |
| GET | `/v1/provenance/package?id=` | Fetch full package |
| GET | `/v1/provenance/certificate?id=` | Fetch signed certificate |
| POST | `/v1/provenance/impact` | Packages affected by an evidence hash |
| POST | `/v1/constitution` | Issue agent constitution |
| POST | `/v1/constitution/check` | Enforce budget/tools/risk |

## Example

```bash
curl -X POST $HOST/v1/provenance/decide \
  -H 'Content-Type: application/json' \
  -d '{
    "question": "¿Re-enrutar carga 4821 por congestión en EZE?",
    "evidence": [{"sensor": "gate-a", "delay_min": 45}],
    "data_snapshot": {"flight": "LA4821", "status": "delayed"}
  }'

curl -X POST $HOST/v1/provenance/replay \
  -H 'Content-Type: application/json' \
  -d '{"package_id": "pkg_..."}'
```

## Silicon Valley one-liner

**Aston OS is the trust kernel for the agent economy: automated decisions as auditable, reversible, and accountable as human ones.**

## Non-claims

- Not air-gapped / DORA offline.
- Model replay is best-effort deterministic (temp 0); bit-identical LLM output is not guaranteed across providers — package hash integrity is.

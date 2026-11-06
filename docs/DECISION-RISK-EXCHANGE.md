# Decision Risk Exchange — ARR Protocol v0

> Aston is the clearing house for the agent economy: autonomous decisions become **measurable, insured, and governable risk**.

## Why blue ocean

Industry is solving agent identity, payments, and trust profiles.  
Aston owns **decision risk**: score → envelope → premium → escrow path → dispute via replay.

## Endpoints

| Method | Path | Purpose |
|--------|------|--------|
| POST | `/v1/risk/score` | ARR only |
| POST | `/v1/risk/underwrite` | ARR + envelope gate + policy + optional provenance |
| POST | `/v1/risk/envelope` | Set agent risk envelope |
| GET | `/v1/risk/envelope?agent_id=` | Read envelope |
| GET | `/v1/risk/status` | Protocol status |

## Demo (logistics)

```bash
curl -X POST $HOST/v1/risk/underwrite \
  -H 'Content-Type: application/json' \
  -d '{
    "question": "Re-route shipment LA4821 via SCL",
    "agent_id": "logistics-router-1",
    "evidence": [{"sensor":"EZE-gate","delay_min":45}],
    "exposure_usd": 12000,
    "reversible": true,
    "data_freshness_hours": 0.5,
    "domain": "logistics"
  }'
```

## Honest limits

- Premiums and policies are **simulated underwriting** (no regulated insurance carrier).
- Capital markets / real escrow settlement = later phase.
- ARR v0 is deterministic rules; actuarial ML is a future upgrade.

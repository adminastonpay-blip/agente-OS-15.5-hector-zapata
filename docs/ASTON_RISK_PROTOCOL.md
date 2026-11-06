# ASTON Risk Protocol v1

> Models think. Agents act. **Aston decides how much trust they deserve.**

## Objects

### Risk Envelope
Limits per `agent_id` + `tenant` + `domain`:
- `max_exposure_usd`
- `max_decisions_per_day`
- `min_arr_score`
- usage counters

### ARR (Aston Risk Rating)
Score 0–100 from evidence, freshness, action risk, agent trust, cascade depth, reversibility, human approval, exposure.

### Assessment
Stored in `risk_assessments` with gate result:

```
if estimated_exposure > max_exposure → require_approval or deny
```

## HTTP

| Method | Path |
|--------|------|
| POST | `/v1/risk/assess` |
| POST | `/v1/risk/score` |
| POST | `/v1/risk/underwrite` |
| POST | `/v1/risk/envelope` |
| GET | `/v1/risk/envelope?agent_id=` |
| GET | `/v1/risk/envelopes` |
| POST | `/v1/agents/plans` (includes risk_gate + max_exposure) |

## Leadership metric

**% of autonomous decisions that are explainable, reproducible, risk-limited, and reversible without manual intervention.**

## Non-claims

Simulated underwriting only — not a licensed insurance product.

# ASTON OS Autodefense

## Pipeline

1. **Collect** (deterministic) — client/logs send evidence
2. **Triage** — signature scoring, no LLM hallucination of attacks
3. **Investigate** — specialized LLM agent only if suspicious/malicious
4. **Mitigate** — observe / soft rate-limit auto; **block requires human** via SafetyInterlock
5. **Approve** — operator decides pending actions

## Endpoints

```bash
# Full pipeline
curl -X POST .../v1/defense/ingest -H 'Content-Type: application/json' \
  -d '{"evidence":[{"source":"waf","kind":"payload","value":"union select from users"},{"source":"edge","kind":"ip","value":"1.2.3.4"}]}'

# Triage only
curl -X POST .../v1/defense/triage -H 'Content-Type: application/json' \
  -d '{"message":"normal page view"}'

# Human approval
curl -X POST .../v1/defense/approve -H 'Content-Type: application/json' \
  -d '{"approval_id":"apr_...","approved":true,"operator":"soc-1"}'
```

## Honesty limits

- Does **not** restart Cloudflare PoPs or "restore the global network".
- Does **not** auto-apply account-wide Firewall rules without CF API token + human policy.
- Assists operators; high-impact blocks stay **pending_approval**.

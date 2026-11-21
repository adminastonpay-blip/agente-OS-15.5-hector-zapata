# ASTON NOC — Incident feed v0.1

## Scope
Adds `GET /v1/engineering/incidents`, a privileged, GET-only incident snapshot derived from the existing Engineering health probe.

## Event semantics
- D1 connectivity failure: critical.
- D1 binding absent: high.
- Empty D1 user schema: high.
- Schema inventory unavailable while D1 connectivity succeeds: medium.
- Missing conventional `d1_migrations` table: low-severity reconciliation observation only; it does not prove migrations were never applied.
- Optional binding absence is not automatically classified as an incident because optional resources may be intentionally disabled.

Every item includes a deterministic event ID, type, severity, open snapshot status, resource, evidence, observation timestamp and source. No historical `first_seen`, acknowledgement, owner, or resolution state is fabricated.

## Security and persistence
- Reuses the existing admin/executor identity gate.
- GET-only; no request-body processing.
- No database writes, incident table, schema migration, queue publish, external service mutation, or production deployment.
- Feed explicitly reports `persistence: not_persisted`, `history_available: false`, and `write_operations: 0`.
- Exception details remain redacted.

## Endpoint
`GET /v1/engineering/incidents`

This is an initial live snapshot, not a durable audit ledger. Durable incident history and acknowledgement workflows require a separately reviewed staging data model and migration plan.

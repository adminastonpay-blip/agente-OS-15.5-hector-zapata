# ASTON Audit Ledger — architecture and integration decision

**Status:** implementation proposal / reviewable feature branch. No production deployment or database migration is included.

## Verified architecture

The live staging D1 catalog contains 21 user tables. Its legacy `audit_log` table is global and has only `id, ts, action, actor, detail`; it has no tenant key, idempotency key, immutable constraint, or event hash. `access_decisions` is tenant-scoped, but it records authorization decisions rather than the complete operational audit stream.

ASTON already has a stronger audit ledger in the SafetyInterlock Durable Object's SQLite storage:
- `audit_events` stores tenant, actor, event type, canonical record JSON, previous hash, and event hash.
- `UNIQUE(tenant, previous_hash)` prevents two committed events from forking the same chain position.
- SQLite triggers reject UPDATE and DELETE.
- `appendAuditEvent` computes a SHA-256 hash chain per tenant.
- `audit_anchor_state` tracks R2 checkpoints; the checkpoint writer uses content-addressed keys.
- External OpenTimestamps/Bitcoin verification is a separate service boundary and must not be reported as complete until independently validated.

Governed-agent lifecycle events already use the per-tenant object name `audit:<tenant>`. The Worker anchor-verification route uses the same namespace.

## Decision

Use the existing SafetyInterlock ledger as the operational source of truth. Do not create a duplicate D1 event table in this phase. Keep D1 `access_decisions` as the policy-decision record and stop adding new records to the legacy global `audit_log`.

This change adds a read-only, tenant-scoped NOC endpoint:
- `GET /v1/audit/events?limit=50&before_id=<cursor>`
- Only authenticated `admin`, `executor`, or `auditor` identities can read.
- Tenant and Durable Object namespace come only from verified identity, never a query parameter.
- Responses include event metadata and hashes, but not raw payload content. Only payload field names are exposed.
- Page-link validation checks links between events returned on that page only. It does not claim full-chain verification or an externally anchored Bitcoin proof.
- Existing `POST /v1/audit` is retired with HTTP 410; it no longer writes unscoped D1/JOURNAL records.

The `/v1/decide` path is switched from best-effort writes to the legacy D1 table to a minimal `decision.inferred` event in the per-tenant hash chain. The event records model, whether RAG was used, and answer length; it does not persist prompts or generated answer text. The response explicitly reports whether the event was persisted when audit anchoring is optional. When `AUDIT_ANCHOR_REQUIRED=true`, failure to append fails closed.

## Integrity and operational limits

- Hash chaining and append-only triggers provide tamper-evidence within the Durable Object's SQLite history; they are not equivalent to independent WORM storage.
- R2 checkpoints and external OTS proofs strengthen evidence only after bucket-lock rules, credentials, scheduled stamping, and verifier service are live-tested.
- The read API returns a bounded page. Its `page_chain_links_valid` result validates only adjacency inside that page.
- The current chain append contract does not yet provide client idempotency keys. A separate change must add replay-safe append semantics before exposing a general-purpose event-ingest API.
- Payload schemas, redaction policy, retention, export, legal hold, and break-glass access require separate review.
- D1 legacy rows are not copied, rewritten, or deleted. No staging or production data was mutated.

## Release gates

1. CI type-check and audit-ledger route tests pass.
2. Security review confirms tenant derivation, role gate, payload redaction, cursor validation, and route guard behavior.
3. Staging runtime test reads only synthetic tenant events and verifies page-link behavior.
4. R2 bucket lock and OTS verifier are independently verified before claiming external anchoring.
5. Any future D1 migration, D1 legacy-data reconciliation, or production deployment requires a separately reviewed change and explicit approval.

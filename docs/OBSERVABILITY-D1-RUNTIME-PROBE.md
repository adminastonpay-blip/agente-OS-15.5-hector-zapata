# ASTON OS — D1 runtime health probe

## Purpose

Adds a private, read-only runtime probe for the Worker-bound D1 database. The endpoint is `GET /v1/engineering/health` and is restricted to authenticated identities with the `admin` or `executor` role. The central API authorization boundary runs before route dispatch; the handler independently rejects public and non-privileged identities.

## Probe contract

- Executes only `SELECT 1 AS probe`; it does not read tenant rows or mutate data.
- Returns `healthy` only when D1 returns the exact numeric value `1`.
- Returns `unknown` and HTTP 503 when the binding is absent.
- Returns `unhealthy` and HTTP 503 when the query fails or the result is unexpected.
- Never returns SQL, exception messages, actor IDs, tenant IDs, credentials, or row data.
- Is allowed by the isolated staging route guard; it does not change production routing or any Cloudflare resource.

## Distributed trace

The request wrapper passes its validated W3C trace context into the route. The D1 probe emits one child event, `aston.operation.span.v1`, with a new span ID and the request span as its parent. The operation name is a closed value (`d1.health_probe`) to keep metric cardinality bounded. No tenant or actor dimension is emitted.

If the optional `OBSERVABILITY` Analytics Engine binding is present, the child span writes a low-cardinality data point. Sink failure is best-effort and does not change the health result. Structured logs remain the fallback.

## Evidence boundary

The response includes a SHA-256 fingerprint over the sanitized probe evidence and trace identifiers. It is ephemeral: it is not persisted, signed, externally anchored, or an append-only audit event. It must not be represented as proof of historical integrity or operator attribution.

## Scope and limitations

This endpoint checks D1 only. Binding presence for AI, Durable Objects, Queues, R2, or other services is not promoted to runtime health. Those require separate, independently scoped probes and tests. No sensitive action is triggered by a health result; existing SafetyInterlock and human-approval controls remain authoritative.

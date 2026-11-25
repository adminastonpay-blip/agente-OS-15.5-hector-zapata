# ASTON OS — Request tracing and operational metrics

## Scope

This increment adds one privacy-safe server span for every HTTP request handled by the Worker. It is deliberately additive: no D1 schema, R2 object, Durable Object state, queue, route authorization, tenant policy, Shopify configuration, or production resource is changed.

## Trace contract

- Accepts a W3C Trace Context v00 `traceparent` only when both trace and parent-span IDs are non-zero and correctly formatted.
- Creates a new trace ID when no valid parent context is supplied.
- Creates a unique span/operation ID for the current Worker request.
- Returns `X-Aston-Trace-Id`, `X-Aston-Operation-Id`, and a child `traceparent` response header.
- Exposes those response headers to browser clients through `Access-Control-Expose-Headers`.
- The trace ID is correlation metadata, never an authentication or authorization credential.

## Span and metric fields

Structured log event: `aston.request.span.v1`.

Fields: `trace_id`, `span_id`, `operation_id`, optional `parent_span_id`, start timestamp, duration in milliseconds, HTTP method, normalized route label, response status, outcome class, and sanitized deployment profile.

When the optional `OBSERVABILITY` Analytics Engine binding exists, one data point is emitted with:
- blobs: normalized route, method, outcome, deployment profile
- doubles: duration milliseconds, HTTP status
- index: normalized route

Unknown routes collapse to `/unmatched`; dynamic resource identifiers and query strings never become metric labels. Request/response bodies, authorization headers, IP addresses, tenant IDs, actor IDs, and exception messages are not emitted.

## Configuration

No binding is provisioned by this code change. To persist metrics in a later approved staging configuration, create a dedicated Analytics Engine dataset and add an environment-specific binding:

```toml
[[analytics_engine_datasets]]
binding = "OBSERVABILITY"
dataset = "aston_request_spans"
```

Until that binding exists, structured Worker logs remain the fallback. Do not add this binding to production without separate resource review and explicit approval.

## Limits and next steps

This is a request-level span, not yet a complete distributed trace. It does not create child spans around individual D1, R2, AI, Queue, or Durable Object calls, and it does not query Analytics Engine or generate anomaly alerts. Those should be added as separate, testable increments with bounded labels and tenant-safe access controls.

The Analytics Engine write is best-effort: sink failure never changes the business response. A thrown request handler is converted to a generic 500 correlated by trace ID; the exception text is intentionally not logged or returned.

## Validation

The accompanying Node test suite covers trace-context validation, parent/child correlation, route cardinality, privacy redaction, response headers, Analytics Engine writes/failure isolation, and generic exception handling.

# ASTON OS — Operational Health Evaluation v1

## Scope
This is a pure deterministic evaluator for already-aggregated metrics. It does not query Analytics Engine, persist results, alert operators, or change request routing. Callers must retrieve aggregates within the existing tenant/authorization boundary. The evaluator accepts no tenant, actor, route, IP, credential, or payload fields.

## Inputs
Evaluation time and window boundaries (epoch milliseconds), sample/error counts, current p95 latency, and optional baseline p95. Invalid counters, missing p95 for a non-empty window, future windows, or windows longer than 24 hours fail closed to unknown/invalid_metrics.

## Versioned thresholds
- Minimum sample count: 5.
- Error rate warning: greater than 5%; critical: 25% or greater.
- Absolute p95 latency: greater than 1,500 ms.
- Regression: greater than max(baseline × 3, baseline + 100 ms).
- Stale: window end older than 120 seconds.
Thresholds are included in the report and its digest.

## Status
- healthy: fresh, adequately sampled, with no defined anomaly.
- degraded: any error-rate, absolute-latency, or baseline-regression signal.
- unknown: invalid metrics, stale window, or insufficient samples (unless a degradation signal also exists).

## Evidence fingerprint
SHA-256 over deterministic JSON serialization of the sanitized evaluation fields, including thresholds and anomalies. This supports reproducibility and tamper comparison; it is not a signature, authenticated source attestation, append-only audit event, or proof of source trustworthiness.

## Tenant and safety boundary
Read-only, no external side effects. Tenant isolation must be enforced before metric retrieval and remains the caller's responsibility. Health status never authorizes sensitive actions; existing policy and human-approval gates remain in force.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateOperationalHealth, HEALTH_THRESHOLDS } from "../src/observability/health-evaluator.ts";
const fresh = (overrides: Record<string, unknown> = {}) => ({
  evaluatedAtMs: 1700000120000, windowStartMs: 1700000000000, windowEndMs: 1700000119000,
  sampleCount: 100, errorCount: 2, p95LatencyMs: 220, baselineP95LatencyMs: 200, ...overrides,
});
test("fresh adequately sampled aggregate is healthy", async () => {
  const result = await evaluateOperationalHealth(fresh());
  assert.equal(result.status, "healthy"); assert.deepEqual(result.anomalies, []);
  assert.match(result.evidenceDigest, /^[a-f0-9]{64}$/);
});
test("error-rate breach degrades and severity escalates at 25 percent", async () => {
  const warning = await evaluateOperationalHealth(fresh({ sampleCount: 20, errorCount: 2 }));
  assert.equal(warning.status, "degraded"); assert.ok(warning.anomalies.some(a => a.code === "high_error_rate" && a.severity === "warning"));
  const critical = await evaluateOperationalHealth(fresh({ sampleCount: 20, errorCount: 6 }));
  assert.equal(critical.status, "degraded"); assert.ok(critical.anomalies.some(a => a.code === "high_error_rate" && a.severity === "critical"));
});
test("absolute p95 and baseline regression trigger distinct anomaly codes", async () => {
  const absolute = await evaluateOperationalHealth(fresh({ p95LatencyMs: HEALTH_THRESHOLDS.maxP95LatencyMs + 1 }));
  assert.ok(absolute.anomalies.some(a => a.code === "high_p95_latency"));
  const regression = await evaluateOperationalHealth(fresh({ p95LatencyMs: 700, baselineP95LatencyMs: 200 }));
  assert.equal(regression.status, "degraded"); assert.ok(regression.anomalies.some(a => a.code === "latency_regression"));
});
test("stale and low-sample windows do not claim healthy status", async () => {
  const stale = await evaluateOperationalHealth(fresh({ windowStartMs: 1699999871000, windowEndMs: 1699999990000 }));
  assert.equal(stale.status, "unknown"); assert.ok(stale.anomalies.some(a => a.code === "stale_window"));
  const sparse = await evaluateOperationalHealth(fresh({ sampleCount: 3, errorCount: 0 }));
  assert.equal(sparse.status, "unknown"); assert.ok(sparse.anomalies.some(a => a.code === "insufficient_samples"));
});
test("zero samples require null p95 and have no fabricated error rate", async () => {
  const result = await evaluateOperationalHealth(fresh({ sampleCount: 0, errorCount: 0, p95LatencyMs: null, baselineP95LatencyMs: null }));
  assert.equal(result.status, "unknown"); assert.equal(result.errorRate, null); assert.equal(result.p95LatencyMs, null);
});
test("invalid counters, future windows, or missing p95 fail closed", async () => {
  for (const input of [fresh({ errorCount: 101 }), fresh({ windowEndMs: 1700000121000 }), fresh({ sampleCount: 10, p95LatencyMs: null }), fresh({ sampleCount: -1 })]) {
    const result = await evaluateOperationalHealth(input as any);
    assert.equal(result.status, "unknown"); assert.ok(result.anomalies.some(a => a.code === "invalid_metrics"));
  }
});
test("evidence digest is stable for identical inputs and changes with metric data", async () => {
  const first = await evaluateOperationalHealth(fresh());
  const second = await evaluateOperationalHealth(fresh());
  const changed = await evaluateOperationalHealth(fresh({ p95LatencyMs: 221 }));
  assert.equal(first.evidenceDigest, second.evidenceDigest); assert.notEqual(first.evidenceDigest, changed.evidenceDigest);
});
test("sanitized report contains no identity or route dimensions", async () => {
  const result = await evaluateOperationalHealth(fresh());
  const keys = Object.keys(result).map(k => k.toLowerCase());
  for (const forbidden of ["tenant", "actor", "token", "payload", "authorization", "ipaddress", "route"]) assert.ok(!keys.includes(forbidden), forbidden);
});
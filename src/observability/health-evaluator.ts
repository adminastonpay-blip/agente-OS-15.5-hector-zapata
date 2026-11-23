/** Pure, deterministic evaluator for scope-local aggregate health metrics. */
export type HealthStatus = "healthy" | "degraded" | "unknown";
export type AnomalyCode = "invalid_metrics" | "insufficient_samples" | "stale_window" | "high_error_rate" | "high_p95_latency" | "latency_regression";
export type AnomalySeverity = "warning" | "critical";
export interface HealthEvaluationInput {
  evaluatedAtMs: number; windowStartMs: number; windowEndMs: number;
  sampleCount: number; errorCount: number; p95LatencyMs: number | null;
  baselineP95LatencyMs?: number | null;
}
export interface HealthAnomaly { code: AnomalyCode; severity: AnomalySeverity; observed?: number; threshold?: number; }
export const HEALTH_THRESHOLDS = Object.freeze({
  minSamples: 5, maxErrorRate: 0.05, criticalErrorRate: 0.25,
  maxP95LatencyMs: 1500, regressionFactor: 3, regressionFloorMs: 100,
  maxWindowAgeMs: 120_000, maxWindowSeconds: 86_400,
});
export interface HealthEvidence {
  schema: "aston.health.evaluation.v1"; status: HealthStatus;
  evaluatedAtMs: number; windowStartMs: number; windowEndMs: number;
  sampleCount: number; errorCount: number; errorRate: number | null;
  p95LatencyMs: number | null; baselineP95LatencyMs: number | null;
  anomalies: HealthAnomaly[]; thresholds: typeof HEALTH_THRESHOLDS;
  /** SHA-256 of sanitized report fields, not a signed attestation. */
  evidenceDigest: string;
}
function safeInt(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}
function valid(input: HealthEvaluationInput): boolean {
  if (!safeInt(input.evaluatedAtMs, 1, Number.MAX_SAFE_INTEGER) ||
      !safeInt(input.windowStartMs, 1, Number.MAX_SAFE_INTEGER) ||
      !safeInt(input.windowEndMs, 1, Number.MAX_SAFE_INTEGER) ||
      input.windowStartMs >= input.windowEndMs || input.windowEndMs > input.evaluatedAtMs ||
      input.windowEndMs - input.windowStartMs > HEALTH_THRESHOLDS.maxWindowSeconds * 1000 ||
      !safeInt(input.sampleCount, 0, 1_000_000) || !safeInt(input.errorCount, 0, input.sampleCount)) return false;
  if (input.sampleCount === 0 ? input.p95LatencyMs !== null :
      typeof input.p95LatencyMs !== "number" || !Number.isFinite(input.p95LatencyMs) || input.p95LatencyMs < 0) return false;
  const baseline = input.baselineP95LatencyMs;
  return baseline === undefined || baseline === null || (typeof baseline === "number" && Number.isFinite(baseline) && baseline >= 0);
}
async function sha256Json(payload: object): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** Malformed data returns unknown; the function has no storage/network side effects. */
export async function evaluateOperationalHealth(input: HealthEvaluationInput): Promise<HealthEvidence> {
  const report = {
    schema: "aston.health.evaluation.v1" as const, status: "unknown" as HealthStatus,
    evaluatedAtMs: safeInt(input.evaluatedAtMs, 1, Number.MAX_SAFE_INTEGER) ? input.evaluatedAtMs : 0,
    windowStartMs: safeInt(input.windowStartMs, 1, Number.MAX_SAFE_INTEGER) ? input.windowStartMs : 0,
    windowEndMs: safeInt(input.windowEndMs, 1, Number.MAX_SAFE_INTEGER) ? input.windowEndMs : 0,
    sampleCount: safeInt(input.sampleCount, 0, 1_000_000) ? input.sampleCount : 0,
    errorCount: safeInt(input.errorCount, 0, 1_000_000) ? input.errorCount : 0,
    errorRate: null as number | null,
    p95LatencyMs: typeof input.p95LatencyMs === "number" && Number.isFinite(input.p95LatencyMs) && input.p95LatencyMs >= 0 ? input.p95LatencyMs : null,
    baselineP95LatencyMs: typeof input.baselineP95LatencyMs === "number" && Number.isFinite(input.baselineP95LatencyMs) && input.baselineP95LatencyMs >= 0 ? input.baselineP95LatencyMs : null,
    anomalies: [] as HealthAnomaly[], thresholds: HEALTH_THRESHOLDS,
  };
  if (!valid(input)) {
    report.anomalies.push({ code: "invalid_metrics", severity: "critical" });
    return { ...report, evidenceDigest: await sha256Json(report) };
  }
  report.errorRate = report.sampleCount === 0 ? null : report.errorCount / report.sampleCount;
  if (report.sampleCount < HEALTH_THRESHOLDS.minSamples)
    report.anomalies.push({ code: "insufficient_samples", severity: "warning", observed: report.sampleCount, threshold: HEALTH_THRESHOLDS.minSamples });
  const age = report.evaluatedAtMs - report.windowEndMs;
  if (age > HEALTH_THRESHOLDS.maxWindowAgeMs)
    report.anomalies.push({ code: "stale_window", severity: "warning", observed: age, threshold: HEALTH_THRESHOLDS.maxWindowAgeMs });
  if (report.errorRate !== null && report.errorRate > HEALTH_THRESHOLDS.maxErrorRate)
    report.anomalies.push({ code: "high_error_rate", severity: report.errorRate >= HEALTH_THRESHOLDS.criticalErrorRate ? "critical" : "warning", observed: report.errorRate, threshold: HEALTH_THRESHOLDS.maxErrorRate });
  if (report.p95LatencyMs !== null && report.p95LatencyMs > HEALTH_THRESHOLDS.maxP95LatencyMs)
    report.anomalies.push({ code: "high_p95_latency", severity: "critical", observed: report.p95LatencyMs, threshold: HEALTH_THRESHOLDS.maxP95LatencyMs });
  if (report.p95LatencyMs !== null && report.baselineP95LatencyMs !== null && report.baselineP95LatencyMs > 0) {
    const limit = Math.max(report.baselineP95LatencyMs * HEALTH_THRESHOLDS.regressionFactor, report.baselineP95LatencyMs + HEALTH_THRESHOLDS.regressionFloorMs);
    if (report.p95LatencyMs > limit) report.anomalies.push({ code: "latency_regression", severity: "warning", observed: report.p95LatencyMs, threshold: limit });
  }
  const degraded = report.anomalies.some((a) => ["high_error_rate", "high_p95_latency", "latency_regression"].includes(a.code));
  const unknown = report.anomalies.some((a) => ["insufficient_samples", "stale_window"].includes(a.code));
  report.status = degraded ? "degraded" : unknown ? "unknown" : "healthy";
  return { ...report, evidenceDigest: await sha256Json(report) };
}
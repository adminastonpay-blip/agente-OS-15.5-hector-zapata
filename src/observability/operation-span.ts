import type { RequestSpanEnv, TraceContext } from "./request-span";

/** Closed operation vocabulary keeps telemetry labels bounded and privacy-safe. */
export type OperationName = "d1.health_probe" | "audit.chain_verify";
export type OperationOutcome = "success" | "error" | "unavailable";

export interface OperationSpanResult<T> {
  value: T;
  spanId: string;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function safeProfile(value?: string): string {
  if (!value) return "unknown";
  const normalized = value.slice(0, 80);
  return /^[a-zA-Z0-9._-]+$/.test(normalized) ? normalized : "custom";
}

function emitOperationSpan(
  env: RequestSpanEnv,
  context: TraceContext,
  spanId: string,
  operation: OperationName,
  startedAt: string,
  durationMs: number,
  outcome: OperationOutcome,
): void {
  const profile = safeProfile(env.DEPLOY_PROFILE);
  const resultCode = outcome === "success" ? 1 : outcome === "unavailable" ? 0 : -1;
  const event = {
    schema: "aston.operation.span.v1",
    event: "operation.completed",
    trace_id: context.traceId,
    span_id: spanId,
    operation_id: spanId,
    parent_span_id: context.spanId,
    operation,
    started_at: startedAt,
    duration_ms: durationMs,
    outcome,
    result_code: resultCode,
    deploy_profile: profile,
  };

  console.log(JSON.stringify(event));
  try {
    env.OBSERVABILITY?.writeDataPoint({
      blobs: [operation, outcome, profile],
      doubles: [durationMs, resultCode],
      indexes: [operation],
    });
  } catch {
    console.warn(JSON.stringify({
      schema: "aston.telemetry.error.v1",
      trace_id: context.traceId,
      span_id: spanId,
      sink: "analytics_engine",
    }));
  }
}

/**
 * Wrap one internal dependency operation in a child span. The operation name is
 * a closed enum; identity, tenant, request data, SQL, and exception text are
 * never emitted. Telemetry failure never changes the operation result.
 */
export async function withOperationSpan<T>(
  context: TraceContext,
  env: RequestSpanEnv,
  operation: OperationName,
  run: () => Promise<T>,
  classify: (value: T) => OperationOutcome,
): Promise<OperationSpanResult<T>> {
  const spanId = randomHex(8);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let outcome: OperationOutcome = "error";

  try {
    const value = await run();
    outcome = classify(value);
    return { value, spanId };
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    const durationMs = Math.max(0, Math.round((performance.now() - started) * 100) / 100);
    emitOperationSpan(env, context, spanId, operation, startedAt, durationMs, outcome);
  }
}

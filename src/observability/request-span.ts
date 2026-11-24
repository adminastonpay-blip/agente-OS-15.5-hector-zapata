/**
 * ASTON request-level tracing and low-cardinality operational metrics.
 * No request bodies, query strings, credentials, IPs, tenant IDs, or actor IDs
 * are emitted by this module.
 */

export interface AnalyticsPoint {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

export interface AnalyticsSink {
  writeDataPoint(point?: AnalyticsPoint): void;
}

export interface RequestSpanEnv {
  DEPLOY_PROFILE?: string;
  OBSERVABILITY?: AnalyticsSink;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  traceparent: string;
}

const TRACEPARENT_V00 = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

const EXACT_ROUTES = new Set([
  "/", "/health", "/chat", "/v1/chat", "/chat/stream", "/v1/chat/stream",
  "/v1/solve", "/v1/tts", "/v1/speech", "/v1/voice", "/v1/voice/profiles",
  "/v1/validate", "/v1/etl/ingest", "/v1/recovery/diagnose",
  "/v1/audit/anchor/verify", "/v1/engineering/overview",
  "/v1/engineering/health", "/v1/engineering/incidents", "/v1/audit/events",
]);

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function createTraceContext(request: Request): TraceContext {
  const incoming = request.headers.get("traceparent") || "";
  const match = TRACEPARENT_V00.exec(incoming);
  const validParent = !!match && match[1].toLowerCase() !== ZERO_TRACE_ID &&
    match[2].toLowerCase() !== ZERO_SPAN_ID;
  const traceId = validParent ? match![1].toLowerCase() : randomHex(16);
  const parentSpanId = validParent ? match![2].toLowerCase() : null;
  const spanId = randomHex(8);
  return {
    traceId,
    spanId,
    parentSpanId,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

/** Maps paths to bounded route labels; unknown paths never become metric labels. */
export function routeTemplate(pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (EXACT_ROUTES.has(path)) return path;
  if (/^\/v1\/engineering\/[^/]+$/.test(path)) return "/v1/engineering/:resource";
  if (/^\/v1\/audit\/[^/]+$/.test(path)) return "/v1/audit/:resource";
  if (/^\/v1\/agents\/[^/]+$/.test(path)) return "/v1/agents/:resource";
  if (/^\/v1\/risk\/[^/]+$/.test(path)) return "/v1/risk/:resource";
  if (/^\/v1\/provenance\/[^/]+$/.test(path)) return "/v1/provenance/:resource";
  if (/^\/v1\/infra\/[^/]+$/.test(path)) return "/v1/infra/:resource";
  if (/^\/v1\/economy\/[^/]+$/.test(path)) return "/v1/economy/:resource";
  if (/^\/v1\/defense\/[^/]+$/.test(path)) return "/v1/defense/:resource";
  if (/^\/v1\/factory\/[^/]+$/.test(path)) return "/v1/factory/:resource";
  return "/unmatched";
}

function safeProfile(value?: string): string {
  if (!value) return "unknown";
  const normalized = value.slice(0, 80);
  return /^[a-zA-Z0-9._-]+$/.test(normalized) ? normalized : "custom";
}

function outcomeFor(status: number): "success" | "redirect" | "client_error" | "server_error" {
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  if (status >= 300) return "redirect";
  return "success";
}

function emitSpan(
  request: Request,
  env: RequestSpanEnv,
  context: TraceContext,
  startedAt: string,
  durationMs: number,
  response: Response,
): void {
  const route = routeTemplate(new URL(request.url).pathname);
  const method = /^[A-Z]{1,12}$/.test(request.method) ? request.method : "OTHER";
  const outcome = outcomeFor(response.status);
  const profile = safeProfile(env.DEPLOY_PROFILE);
  const span = {
    schema: "aston.request.span.v1",
    event: "request.completed",
    trace_id: context.traceId,
    span_id: context.spanId,
    operation_id: context.spanId,
    parent_span_id: context.parentSpanId,
    started_at: startedAt,
    duration_ms: durationMs,
    method,
    route,
    status_code: response.status,
    outcome,
    deploy_profile: profile,
  };

  // Structured logs remain the fallback when Analytics Engine is not bound.
  console.log(JSON.stringify(span));

  try {
    env.OBSERVABILITY?.writeDataPoint({
      blobs: [route, method, outcome, profile],
      doubles: [durationMs, response.status],
      indexes: [route],
    });
  } catch {
    // Telemetry is best-effort and must never change the business response.
    console.warn(JSON.stringify({
      schema: "aston.telemetry.error.v1",
      trace_id: context.traceId,
      span_id: context.spanId,
      sink: "analytics_engine",
    }));
  }
}

/** Wraps one incoming Worker operation in a bounded, privacy-safe span. */
export async function withRequestSpan(
  request: Request,
  env: RequestSpanEnv,
  next: (context: TraceContext) => Promise<Response>,
): Promise<Response> {
  const context = createTraceContext(request);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let response: Response;

  try {
    response = await next(context);
  } catch {
    response = Response.json({
      ok: false,
      error: "internal_error",
      trace_id: context.traceId,
    }, { status: 500 });
  }

  const durationMs = Math.max(0, Math.round((performance.now() - start) * 100) / 100);
  emitSpan(request, env, context, startedAt, durationMs, response);

  const headers = new Headers(response.headers);
  headers.set("X-Aston-Trace-Id", context.traceId);
  headers.set("X-Aston-Operation-Id", context.spanId);
  headers.set("traceparent", context.traceparent);
  const exposed = (headers.get("Access-Control-Expose-Headers") || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  for (const name of ["X-Aston-Trace-Id", "X-Aston-Operation-Id", "traceparent"]) {
    if (!exposed.some((value) => value.toLowerCase() === name.toLowerCase())) exposed.push(name);
  }
  headers.set("Access-Control-Expose-Headers", exposed.join(", "));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import {
  createTraceContext,
  routeTemplate,
  withRequestSpan,
  type AnalyticsPoint,
} from "../src/observability/request-span.ts";

function captureLogs(run: () => Promise<Response>) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const logs: string[] = [];
  const warnings: string[] = [];
  console.log = (value?: unknown) => logs.push(String(value));
  console.warn = (value?: unknown) => warnings.push(String(value));
  return run().finally(() => {
    console.log = originalLog;
    console.warn = originalWarn;
  }).then((response) => ({ response, logs, warnings }));
}

test("creates a fresh W3C trace context when no valid parent is supplied", () => {
  const context = createTraceContext(new Request("https://aston.invalid/health"));
  assert.match(context.traceId, /^[a-f0-9]{32}$/);
  assert.match(context.spanId, /^[a-f0-9]{16}$/);
  assert.equal(context.parentSpanId, null);
  assert.equal(context.traceparent, `00-${context.traceId}-${context.spanId}-01`);
});

test("continues a valid W3C trace without reusing the parent span id", () => {
  const request = new Request("https://aston.invalid/v1/chat", {
    headers: { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
  });
  const context = createTraceContext(request);
  assert.equal(context.traceId, "11111111111111111111111111111111");
  assert.equal(context.parentSpanId, "2222222222222222");
  assert.notEqual(context.spanId, context.parentSpanId);
});

test("rejects zero or malformed traceparent identifiers", () => {
  const zero = new Request("https://aston.invalid/", {
    headers: { traceparent: "00-00000000000000000000000000000000-2222222222222222-01" },
  });
  const malformed = new Request("https://aston.invalid/", {
    headers: { traceparent: "not-a-traceparent" },
  });
  assert.equal(createTraceContext(zero).parentSpanId, null);
  assert.equal(createTraceContext(malformed).parentSpanId, null);
});

test("normalizes dynamic and unknown routes to bounded labels", () => {
  assert.equal(routeTemplate("/v1/engineering/health"), "/v1/engineering/health");
  assert.equal(routeTemplate("/v1/engineering/incidents/incident-secret-id"), "/unmatched");
  assert.equal(routeTemplate("/v1/risk/assess"), "/v1/risk/:resource");
  assert.equal(routeTemplate("/customer/private-email@example.com"), "/unmatched");
});

test("adds trace headers and emits privacy-safe structured telemetry", async () => {
  const request = new Request("https://aston.invalid/v1/engineering/health?token=do-not-log", {
    headers: { authorization: "Bearer do-not-log" },
  });
  const { response, logs } = await captureLogs(() => withRequestSpan(
    request,
    { DEPLOY_PROFILE: "staging-21x" },
    async () => new Response("healthy", { status: 200, headers: { "Content-Type": "text/plain" } }),
  ));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "healthy");
  assert.match(response.headers.get("X-Aston-Trace-Id") || "", /^[a-f0-9]{32}$/);
  assert.match(response.headers.get("X-Aston-Operation-Id") || "", /^[a-f0-9]{16}$/);
  assert.ok(response.headers.get("traceparent"));
  assert.match(response.headers.get("Access-Control-Expose-Headers") || "", /X-Aston-Trace-Id/);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('"schema":"aston.request.span.v1"'));
  assert.ok(logs[0].includes('"route":"/v1/engineering/health"'));
  assert.ok(!logs[0].includes("do-not-log"));
  assert.ok(!logs[0].includes("token"));
});

test("writes low-cardinality Analytics Engine metrics without blocking the response", async () => {
  const points: AnalyticsPoint[] = [];
  const request = new Request("https://aston.invalid/v1/risk/assess?customer=private", { method: "POST" });
  const { response } = await captureLogs(() => withRequestSpan(
    request,
    { OBSERVABILITY: { writeDataPoint: (point) => points.push(point) } },
    async () => new Response("accepted", { status: 202 }),
  ));
  assert.equal(response.status, 202);
  assert.equal(points.length, 1);
  assert.deepEqual(points[0].blobs?.slice(0, 3), ["/v1/risk/:resource", "POST", "success"]);
  assert.equal(points[0].doubles?.[1], 202);
  assert.deepEqual(points[0].indexes, ["/v1/risk/:resource"]);
  assert.ok(typeof points[0].doubles?.[0] === "number");
});

test("Analytics Engine failures are non-fatal and produce a redacted warning", async () => {
  const { response, warnings } = await captureLogs(() => withRequestSpan(
    new Request("https://aston.invalid/health"),
    { OBSERVABILITY: { writeDataPoint: () => { throw new Error("secret sink detail"); } } },
    async () => new Response("ok", { status: 200 }),
  ));
  assert.equal(response.status, 200);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes("secret sink detail"));
});

test("converts uncaught handler exceptions to a correlated generic 500", async () => {
  const { response, logs } = await captureLogs(() => withRequestSpan(
    new Request("https://aston.invalid/v1/chat"),
    {},
    async () => { throw new Error("customer payload must not leak"); },
  ));
  assert.equal(response.status, 500);
  const body = await response.json() as { error: string; trace_id: string };
  assert.equal(body.error, "internal_error");
  assert.equal(body.trace_id, response.headers.get("X-Aston-Trace-Id"));
  assert.ok(logs[0].includes('"outcome":"server_error"'));
  assert.ok(!logs[0].includes("customer payload"));
});

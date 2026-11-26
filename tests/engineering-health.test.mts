import test from "node:test";
import assert from "node:assert/strict";
import { handleEngineeringHealth } from "../src/routes/engineering-health.ts";
import { withOperationSpan } from "../src/observability/operation-span.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const admin = { actor: "operator-1", method: "access", tenant: "tenant-a", roles: ["admin"], clearance: "confidential" } as const;
const viewer = { actor: "viewer-1", method: "access", tenant: "tenant-a", roles: ["viewer"], clearance: "internal" } as const;
const publicAdmin = { ...admin, method: "public" } as const;
const trace = { traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: null, traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` };

async function capture<T>(run: () => Promise<T>) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const logs: string[] = [];
  const warnings: string[] = [];
  console.log = (value?: unknown) => logs.push(String(value));
  console.warn = (value?: unknown) => warnings.push(String(value));
  try { return { value: await run(), logs, warnings }; }
  finally { console.log = originalLog; console.warn = originalWarn; }
}

function request(method = "GET") {
  return new Request("https://aston.internal/v1/engineering/health", { method });
}

test("does not handle unrelated paths", async () => {
  const result = await handleEngineeringHealth("/health", request(), {} as any, admin as any, json, trace);
  assert.equal(result, null);
});

test("requires GET and a verified privileged identity", async () => {
  const method = await handleEngineeringHealth("/v1/engineering/health", request("POST"), {} as any, admin as any, json, trace);
  assert.equal(method?.status, 405);
  const viewerResult = await handleEngineeringHealth("/v1/engineering/health", request(), {} as any, viewer as any, json, trace);
  assert.equal(viewerResult?.status, 403);
  const publicResult = await handleEngineeringHealth("/v1/engineering/health", request(), {} as any, publicAdmin as any, json, trace);
  assert.equal(publicResult?.status, 403);
});

test("performs a real D1 SELECT 1 and emits a correlated child span", async () => {
  const points: any[] = [];
  let sql = "";
  const env = {
    DEPLOY_PROFILE: "staging",
    DB: { prepare(query: string) { sql = query; return { first: async () => ({ probe: 1 }) }; } },
    OBSERVABILITY: { writeDataPoint(point: any) { points.push(point); } },
  } as any;
  const captured = await capture(() => handleEngineeringHealth("/v1/engineering/health", request(), env, admin as any, json, trace));
  const response = captured.value!;
  const body = await response.json() as any;
  assert.equal(sql, "SELECT 1 AS probe");
  assert.equal(response.status, 200);
  assert.equal(body.status, "healthy");
  assert.equal(body.mode, "runtime_probe");
  assert.equal(body.scope, "d1_only");
  assert.equal(body.trace_id, trace.traceId);
  assert.match(body.operation_id, /^[a-f0-9]{16}$/);
  assert.notEqual(body.operation_id, body.request_operation_id);
  assert.match(body.evidence.digest, /^[a-f0-9]{64}$/);
  assert.equal(body.evidence_guarantee, "ephemeral_sha256_fingerprint_not_persisted_or_signed");
  assert.equal(captured.logs.length, 1);
  const span = JSON.parse(captured.logs[0]);
  assert.equal(span.schema, "aston.operation.span.v1");
  assert.equal(span.trace_id, trace.traceId);
  assert.equal(span.parent_span_id, trace.spanId);
  assert.equal(span.operation, "d1.health_probe");
  assert.equal(span.outcome, "success");
  assert.ok(!JSON.stringify(span).includes("tenant-a"));
  assert.deepEqual(points[0].blobs.slice(0, 2), ["d1.health_probe", "success"]);
});

test("missing D1 fails closed as unknown and records unavailable", async () => {
  const captured = await capture(() => handleEngineeringHealth("/v1/engineering/health", request(), {} as any, admin as any, json, trace));
  const response = captured.value!;
  const body = await response.json() as any;
  assert.equal(response.status, 503);
  assert.equal(body.status, "unknown");
  assert.equal(JSON.parse(captured.logs[0]).outcome, "unavailable");
});

test("D1 failure is sanitized and records an error outcome", async () => {
  const env = { DB: { prepare() { return { first: async () => { throw new Error("sensitive SQL and account details"); } }; } } } as any;
  const captured = await capture(() => handleEngineeringHealth("/v1/engineering/health", request(), env, admin as any, json, trace));
  const body = await captured.value!.json() as any;
  assert.equal(captured.value!.status, 503);
  assert.equal(body.status, "unhealthy");
  assert.equal(JSON.stringify(body).includes("sensitive SQL"), false);
  assert.equal(JSON.stringify(captured.logs).includes("sensitive SQL"), false);
  assert.equal(JSON.parse(captured.logs[0]).outcome, "error");
});

test("operation exceptions are rethrown without logging exception contents", async () => {
  const captured = await capture(async () => {
    await assert.rejects(
      withOperationSpan(trace, {}, "d1.health_probe", async () => { throw new Error("secret detail"); }, () => "success"),
      /secret detail/,
    );
  });
  assert.equal(JSON.parse(captured.logs[0]).outcome, "error");
  assert.equal(JSON.stringify(captured.logs).includes("secret detail"), false);
});

test("telemetry sink failure does not change the probe result", async () => {
  const env = {
    DB: { prepare() { return { first: async () => ({ probe: 1 }) }; } },
    OBSERVABILITY: { writeDataPoint() { throw new Error("sink unavailable"); } },
  } as any;
  const captured = await capture(() => handleEngineeringHealth("/v1/engineering/health", request(), env, admin as any, json, trace));
  assert.equal(captured.value!.status, 200);
  assert.equal(captured.warnings.length, 1);
  assert.equal(captured.warnings[0].includes("sink unavailable"), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { handleEngineeringAuditVerification } from "../src/routes/engineering-audit.ts";
import { routeTemplate } from "../src/observability/request-span.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const admin = {
  actor: "operator-1", method: "access", tenant: "tenant-a",
  roles: ["admin"], clearance: "confidential",
} as const;
const executor = { ...admin, roles: ["executor"] } as const;
const viewer = { ...admin, roles: ["viewer"] } as const;
const publicAdmin = { ...admin, method: "public" } as const;
const trace = {
  traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: null,
  traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
};

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

function request(query = "", method = "GET") {
  return new Request(`https://aston.internal/v1/engineering/audit/verify${query}`, { method });
}

function auditEnv(
  payload: unknown,
  options: { status?: number; throwOnFetch?: boolean } = {},
) {
  let namespaceName = "";
  let requestedUrl = "";
  let requestedMethod = "";
  const points: any[] = [];
  const env: any = {
    OBSERVABILITY: { writeDataPoint(point: any) { points.push(point); } },
    SAFETY: {
      idFromName(name: string) { namespaceName = name; return name; },
      get(_id: unknown) {
        return {
          async fetch(url: string, init?: RequestInit) {
            requestedUrl = String(url);
            requestedMethod = init?.method || "GET";
            if (options.throwOnFetch) throw new Error("private DO detail");
            return Response.json(payload, { status: options.status ?? 200 });
          },
        };
      },
    },
  };
  return {
    env, points,
    calls: () => ({ namespaceName, requestedUrl, requestedMethod }),
  };
}

test("leaves unrelated routes untouched and uses a bounded route label", async () => {
  const result = await handleEngineeringAuditVerification(
    "/v1/engineering/health", request(), {} as any, admin as any, json, trace,
  );
  assert.equal(result, null);
  assert.equal(routeTemplate("/v1/engineering/audit/verify"), "/v1/engineering/audit/verify");
});

test("requires GET and a verified admin or executor identity", async () => {
  const env = auditEnv({ tenant: "tenant-a", intact: true, events: 1 }).env;
  const method = await handleEngineeringAuditVerification(
    "/v1/engineering/audit/verify", request("", "POST"), env, admin as any, json, trace,
  );
  const deniedViewer = await handleEngineeringAuditVerification(
    "/v1/engineering/audit/verify", request(), env, viewer as any, json, trace,
  );
  const deniedPublic = await handleEngineeringAuditVerification(
    "/v1/engineering/audit/verify", request(), env, publicAdmin as any, json, trace,
  );
  assert.equal(method?.status, 405);
  assert.equal(deniedViewer?.status, 403);
  assert.equal(deniedPublic?.status, 403);
});

test("rejects a caller-supplied tenant override before touching the Durable Object", async () => {
  const fixture = auditEnv({ tenant: "tenant-a", intact: true, events: 1 });
  const response = await handleEngineeringAuditVerification(
    "/v1/engineering/audit/verify", request("?tenant=tenant-b"),
    fixture.env, admin as any, json, trace,
  );
  assert.equal(response?.status, 400);
  assert.deepEqual(fixture.calls(), { namespaceName: "", requestedUrl: "", requestedMethod: "" });
});

test("verifies only the authenticated tenant and emits a correlated child span", async () => {
  const fixture = auditEnv({ tenant: "tenant-a", intact: true, events: 3 });
  const captured = await capture(() => handleEngineeringAuditVerification(
    "/v1/engineering/audit/verify", request(),
    fixture.env, admin as any, json, trace,
  ));
  const response = captured.value!;
  const body = await response.json() as any;
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, "intact");
  assert.equal(body.integrity, true);
  assert.equal(body.events, 3);
  assert.match(body.tenant_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(body).includes("tenant-a"), false);
  assert.deepEqual(fixture.calls(), {
    namespaceName: "audit:tenant-a",
    requestedUrl: "https://safety.internal/audit/verify?tenant=tenant-a",
    requestedMethod: "GET",
  });
  assert.equal(captured.logs.length, 1);
  const span = JSON.parse(captured.logs[0]);
  assert.equal(span.schema, "aston.operation.span.v1");
  assert.equal(span.operation, "audit.chain_verify");
  assert.equal(span.trace_id, trace.traceId);
  assert.equal(span.parent_span_id, trace.spanId);
  assert.equal(span.outcome, "success");
  assert.equal(JSON.stringify(span).includes("tenant-a"), false);
  assert.deepEqual(fixture.points[0].blobs.slice(0, 2), ["audit.chain_verify", "success"]);
  assert.match(body.evidence.digest, /^[a-f0-9]{64}$/);
  assert.equal(body.evidence_guarantee, "ephemeral_sha256_fingerprint_not_persisted_or_signed");
});

test("reports an empty chain distinctly from an intact chain with events", async () => {
  const fixture = auditEnv({ tenant: "tenant-a", intact: true, events: 0 });
  const response = await handleEngineeringAuditVerification(
    "/v1/engineering/audit/verify", request(), fixture.env, executor as any, json, trace,
  );
  const body = await response!.json() as any;
  assert.equal(response!.status, 200);
  assert.equal(body.status, "empty");
  assert.equal(body.integrity, true);
  assert.equal(body.events, 0);
});

test("reports a hash-chain mismatch as conflict and records an error outcome", async () => {
  const fixture = auditEnv({ tenant: "tenant-a", intact: false, events: 2 });
  const captured = await capture(() => handleEngineeringAuditVerification(
    "/v1/engineering/audit/verify", request(), fixture.env, admin as any, json, trace,
  ));
  const body = await captured.value!.json() as any;
  assert.equal(captured.value!.status, 409);
  assert.equal(body.ok, false);
  assert.equal(body.status, "mismatch");
  assert.equal(body.integrity, false);
  assert.equal(JSON.parse(captured.logs[0]).outcome, "error");
});

test("fails closed for a missing binding, unavailable DO, or malformed tenant response", async () => {
  const missing = await capture(() => handleEngineeringAuditVerification(
    "/v1/engineering/audit/verify", request(), {} as any, admin as any, json, trace,
  ));
  assert.equal(missing.value!.status, 503);
  assert.equal((await missing.value!.json() as any).status, "unknown");
  assert.equal(JSON.parse(missing.logs[0]).outcome, "unavailable");

  const unavailableFixture = auditEnv(null, { status: 503 });
  const unavailable = await handleEngineeringAuditVerification(
    "/v1/engineering/audit/verify", request(), unavailableFixture.env, admin as any, json, trace,
  );
  assert.equal(unavailable!.status, 503);

  const malformedFixture = auditEnv({ tenant: "tenant-b", intact: true, events: 1 });
  const malformed = await capture(() => handleEngineeringAuditVerification(
    "/v1/engineering/audit/verify", request(), malformedFixture.env, admin as any, json, trace,
  ));
  assert.equal(malformed.value!.status, 503);
  assert.equal((await malformed.value!.json() as any).integrity, null);
  assert.equal(JSON.parse(malformed.logs[0]).outcome, "error");
});

test("does not expose Durable Object exceptions and isolates telemetry sink failure", async () => {
  const fixture = auditEnv(null, { throwOnFetch: true });
  const failed = await capture(() => handleEngineeringAuditVerification(
    "/v1/engineering/audit/verify", request(), fixture.env, admin as any, json, trace,
  ));
  const failedBody = await failed.value!.json() as any;
  assert.equal(failed.value!.status, 503);
  assert.equal(JSON.stringify(failedBody).includes("private DO detail"), false);
  assert.equal(JSON.stringify(failed.logs).includes("private DO detail"), false);

  const telemetryFixture = auditEnv({ tenant: "tenant-a", intact: true, events: 1 });
  telemetryFixture.env.OBSERVABILITY.writeDataPoint = () => { throw new Error("sink secret"); };
  const telemetry = await capture(() => handleEngineeringAuditVerification(
    "/v1/engineering/audit/verify", request(), telemetryFixture.env, admin as any, json, trace,
  ));
  assert.equal(telemetry.value!.status, 200);
  assert.equal(telemetry.warnings.length, 1);
  assert.equal(telemetry.warnings[0].includes("sink secret"), false);
});

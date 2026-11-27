import test from "node:test";
import assert from "node:assert/strict";
import { handleEngineeringAuditAnchorVerification } from "../src/routes/engineering-audit-anchor.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const admin = { actor: "operator-1", method: "access", tenant: "tenant-a", roles: ["admin"], clearance: "confidential" } as const;
const viewer = { actor: "viewer-1", method: "access", tenant: "tenant-a", roles: ["viewer"], clearance: "internal" } as const;
const publicAdmin = { ...admin, method: "public" } as const;
const trace = { traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: null, traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` };
const rootHash = "c".repeat(64);
const verifiedPayload = {
  ok: true, integrity: true, local_state_missing: false, tenant_hash: "d".repeat(64),
  event_count: 100, root_hash: rootHash, bitcoin_block_height: 900001, bitcoin_timestamp: 1794300000,
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

function request(body: unknown = { event_count: 100 }, method = "POST") {
  return new Request("https://aston.internal/v1/audit/anchor/verify", {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

function envFor(status: number, payload: unknown, observed?: { name?: string; body?: unknown; url?: string }) {
  return {
    DEPLOY_PROFILE: "staging",
    OBSERVABILITY: { writeDataPoint() {} },
    SAFETY: {
      idFromName(name: string) { if (observed) observed.name = name; return "stub-id"; },
      get(_id: unknown) {
        return {
          async fetch(url: string, init: RequestInit) {
            if (observed) {
              observed.url = url;
              observed.body = JSON.parse(String(init.body));
            }
            return new Response(JSON.stringify(payload), { status });
          },
        };
      },
    },
  } as any;
}

test("does not handle unrelated paths", async () => {
  const result = await handleEngineeringAuditAnchorVerification("/v1/engineering/health", request(), {} as any, admin as any, json, trace);
  assert.equal(result, null);
});

test("requires POST and a verified privileged identity", async () => {
  const method = await handleEngineeringAuditAnchorVerification("/v1/audit/anchor/verify", request(undefined, "GET"), {} as any, admin as any, json, trace);
  assert.equal(method?.status, 405);
  const viewerResult = await handleEngineeringAuditAnchorVerification("/v1/audit/anchor/verify", request(), {} as any, viewer as any, json, trace);
  assert.equal(viewerResult?.status, 403);
  const publicResult = await handleEngineeringAuditAnchorVerification("/v1/audit/anchor/verify", request(), {} as any, publicAdmin as any, json, trace);
  assert.equal(publicResult?.status, 403);
});

test("rejects invalid event counts and every caller-supplied tenant field", async () => {
  for (const body of [{ event_count: 0 }, { event_count: 1.5 }, { event_count: 1_000_000_001 }, { event_count: 100, tenant: "tenant-b" }, { event_count: 100, extra: true }, null]) {
    const response = await handleEngineeringAuditAnchorVerification("/v1/audit/anchor/verify", request(body), envFor(200, verifiedPayload), admin as any, json, trace);
    assert.equal(response?.status, 400);
  }
});

test("selects the Durable Object from verified tenant and returns correlated confirmed evidence", async () => {
  const observed: { name?: string; body?: unknown; url?: string } = {};
  const points: any[] = [];
  const env = envFor(200, verifiedPayload, observed);
  env.OBSERVABILITY.writeDataPoint = (point: any) => points.push(point);
  const captured = await capture(() => handleEngineeringAuditAnchorVerification("/v1/audit/anchor/verify", request(), env, admin as any, json, trace));
  const response = captured.value!;
  const body = await response.json() as any;

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, "confirmed");
  assert.equal(body.integrity, true);
  assert.equal(body.event_count, 100);
  assert.equal(body.root_hash, rootHash);
  assert.equal(body.bitcoin_block_height, 900001);
  assert.equal(body.bitcoin_timestamp, 1794300000);
  assert.equal(body.trace_id, trace.traceId);
  assert.match(body.operation_id, /^[a-f0-9]{16}$/);
  assert.notEqual(body.operation_id, body.request_operation_id);
  assert.match(body.evidence.digest, /^[a-f0-9]{64}$/);
  assert.equal(body.evidence_guarantee, "ephemeral_sha256_fingerprint_not_persisted_or_signed");
  assert.equal(observed.name, "audit:tenant-a");
  assert.equal(observed.url, "https://safety.internal/audit/anchor/verify");
  assert.deepEqual(observed.body, { tenant: "tenant-a", event_count: 100 });
  assert.equal(JSON.stringify(body).includes("tenant-a"), false);
  assert.equal(JSON.stringify(body).includes("tenant_hash"), false);
  assert.equal(JSON.stringify(captured.logs).includes("tenant-a"), false);
  const span = JSON.parse(captured.logs[0]);
  assert.equal(span.operation, "audit.external_anchor_verify");
  assert.equal(span.outcome, "success");
  assert.equal(span.parent_span_id, trace.spanId);
  assert.deepEqual(points[0].blobs.slice(0, 2), ["audit.external_anchor_verify", "success"]);
});

test("maps missing anchors and local-root mismatches without exposing verifier internals", async () => {
  for (const [status, expectedStatus, expectedHttp] of [[404, "not_found", 404], [409, "mismatch", 409]] as const) {
    const captured = await capture(() => handleEngineeringAuditAnchorVerification("/v1/audit/anchor/verify", request(), envFor(status, { error: "internal-detail", tenant_hash: "secret" }), admin as any, json, trace));
    const response = captured.value!;
    const body = await response.json() as any;
    assert.equal(response.status, expectedHttp);
    assert.equal(body.status, expectedStatus);
    assert.equal(JSON.stringify(body).includes("internal-detail"), false);
    assert.equal(JSON.parse(captured.logs[0]).outcome, "error");
  }
});

test("missing binding and unavailable verifier fail closed with unavailable spans", async () => {
  const missing = await capture(() => handleEngineeringAuditAnchorVerification("/v1/audit/anchor/verify", request(), {} as any, admin as any, json, trace));
  assert.equal(missing.value!.status, 503);
  assert.equal((await missing.value!.json() as any).status, "unknown");
  assert.equal(JSON.parse(missing.logs[0]).outcome, "unavailable");

  const unavailable = await capture(() => handleEngineeringAuditAnchorVerification("/v1/audit/anchor/verify", request(), envFor(503, { reason: "secret-service-detail" }), admin as any, json, trace));
  assert.equal(unavailable.value!.status, 503);
  assert.equal(JSON.stringify(await unavailable.value!.json()).includes("secret-service-detail"), false);
  assert.equal(JSON.parse(unavailable.logs[0]).outcome, "unavailable");
});

test("rejects malformed successful verifier responses and transport exceptions", async () => {
  const malformed = await capture(() => handleEngineeringAuditAnchorVerification("/v1/audit/anchor/verify", request(), envFor(200, { ...verifiedPayload, root_hash: "wrong" }), admin as any, json, trace));
  assert.equal(malformed.value!.status, 503);
  assert.equal((await malformed.value!.json() as any).error, "external_anchor_response_invalid");
  assert.equal(JSON.parse(malformed.logs[0]).outcome, "error");

  const throwingEnv = {
    SAFETY: { idFromName() { return "id"; }, get() { return { async fetch() { throw new Error("private verifier detail"); } }; } },
  } as any;
  const throwing = await capture(() => handleEngineeringAuditAnchorVerification("/v1/audit/anchor/verify", request(), throwingEnv, admin as any, json, trace));
  assert.equal(throwing.value!.status, 503);
  assert.equal(JSON.stringify(await throwing.value!.json()).includes("private verifier detail"), false);
  assert.equal(JSON.parse(throwing.logs[0]).outcome, "unavailable");
});

test("telemetry sink failure does not change verified evidence", async () => {
  const env = envFor(200, verifiedPayload);
  env.OBSERVABILITY.writeDataPoint = () => { throw new Error("private telemetry detail"); };
  const captured = await capture(() => handleEngineeringAuditAnchorVerification("/v1/audit/anchor/verify", request(), env, admin as any, json, trace));
  assert.equal(captured.value!.status, 200);
  assert.equal(captured.warnings.length, 1);
  assert.equal(captured.warnings[0].includes("private telemetry detail"), false);
});

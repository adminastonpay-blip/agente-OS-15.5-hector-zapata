import type { Env } from "../types";

const RUNS_PATH = "/v1/vbc/runs";
const MAX_BODY_BYTES = 128 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RUN_ID_RE = /^[a-f0-9-]{36}$/;
const TEST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{1,119}$/;
const TENANT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,79}$/;

type AuditRun = {
  run_id: string;
  tenant_id: string;
  suite_name: string;
  suite_version: string;
  status: "running" | "succeeded" | "failed";
  created_at: string;
  started_at: string;
  finished_at: string | null;
  software_hash: string;
  target_commit: string;
  expected_test_count: number;
};

type TestResult = {
  result_id: string;
  run_id: string;
  test_name: string;
  status_http: number;
  passed: number;
  result_json: string;
  evidence_sha256: string;
  created_at: string;
};

type ManifestInput = {
  run: AuditRun;
  tests: TestResult[];
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const target: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) target[key] = canonicalize(source[key]);
    return target;
  }
  return value;
}

/** RFC-8785-inspired deterministic JSON for this restricted JSON data model. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildEvidenceManifest(input: ManifestInput) {
  const { run } = input;
  const tests = [...input.tests].sort((a, b) => a.test_name.localeCompare(b.test_name));
  const nodes: Array<Record<string, unknown>> = [
    {
      id: `run:${run.run_id}`,
      type: "audit_run",
      run_id: run.run_id,
      tenant_id: run.tenant_id,
      suite: { name: run.suite_name, version: run.suite_version },
      status: run.status,
      started_at: run.started_at,
      finished_at: run.finished_at,
    },
    {
      id: `software:${run.software_hash}`,
      type: "software_artifact",
      sha256: run.software_hash,
      target_commit: run.target_commit,
    },
  ];
  const edges: Array<Record<string, string>> = [
    { from: `run:${run.run_id}`, to: `software:${run.software_hash}`, relation: "executed_against" },
  ];

  for (const test of tests) {
    const testNode = `test:${test.result_id}`;
    const evidenceNode = `evidence:${test.evidence_sha256}`;
    nodes.push({
      id: testNode,
      type: "test_result",
      test_name: test.test_name,
      http_status: test.status_http,
      passed: test.passed === 1,
      recorded_at: test.created_at,
    });
    nodes.push({
      id: evidenceNode,
      type: "evidence",
      sha256: test.evidence_sha256,
      media_type: "application/json",
      details: JSON.parse(test.result_json),
    });
    edges.push(
      { from: `run:${run.run_id}`, to: testNode, relation: "contains_test_result" },
      { from: testNode, to: evidenceNode, relation: "supported_by" },
    );
  }

  const manifest = {
    schema: "aston.vbc.evidence-manifest",
    schema_version: "1.0.0",
    canonicalization: "aston-canonical-json-v1",
    generated_at: run.finished_at,
    issuer: { name: "ASTON OS", role: "manifest_generator" },
    audit: {
      run_id: run.run_id,
      tenant_id: run.tenant_id,
      suite_name: run.suite_name,
      suite_version: run.suite_version,
      status: run.status,
      started_at: run.started_at,
      finished_at: run.finished_at,
      software_sha256: run.software_hash,
      target_commit: run.target_commit,
      expected_test_count: run.expected_test_count,
      recorded_test_count: tests.length,
      passed_test_count: tests.filter((test) => test.passed === 1).length,
      failed_test_count: tests.filter((test) => test.passed !== 1).length,
    },
    graph: { nodes, edges },
    verification: {
      manifest_sha256: null,
      manifest_sha256_scope: "SHA-256 of the canonical manifest JSON bytes stored in manifest_json",
      pdf_signature: "not_implemented",
      bitcoin_ots: "not_anchored",
      independent_verification: "not_yet_available",
    },
  };
  const canonical = canonicalJson(manifest);
  return {
    manifest,
    canonical,
    sha256: await sha256Hex(canonical),
  };
}

async function readBoundedJson(req: Request): Promise<any> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new Error("body_too_large");
  const reader = req.body?.getReader();
  if (!reader) throw new Error("empty_body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel("body_too_large");
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function constantTimeSecretMatch(supplied: string, expected: string): Promise<boolean> {
  if (!supplied || !expected || supplied.length !== expected.length) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}

function response(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function isStaging(env: Env): boolean {
  return String(env.DEPLOY_PROFILE || "").toLowerCase().includes("staging");
}

async function authorize(req: Request, env: Env): Promise<boolean> {
  if (!env.AUDIT_SECRET || env.AUDIT_SECRET.length < 32) return false;
  return constantTimeSecretMatch(req.headers.get("x-audit-token") || "", env.AUDIT_SECRET);
}

function validateRunBody(body: any): boolean {
  return !!body &&
    typeof body.tenant_id === "string" && TENANT_RE.test(body.tenant_id) &&
    typeof body.suite_name === "string" && body.suite_name.length > 0 && body.suite_name.length <= 100 &&
    typeof body.suite_version === "string" && body.suite_version.length > 0 && body.suite_version.length <= 40 &&
    typeof body.software_hash === "string" && HASH_RE.test(body.software_hash) &&
    typeof body.target_commit === "string" && COMMIT_RE.test(body.target_commit) &&
    Number.isInteger(body.expected_test_count) && body.expected_test_count >= 1 && body.expected_test_count <= 500;
}

/**
 * Staging-only, shared-secret-protected registry ingress for the trusted ARP
 * orchestrator. Browser clients must never receive AUDIT_SECRET.
 */
export async function handleVbcRegistry(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path !== RUNS_PATH && !path.startsWith(RUNS_PATH + "/")) return null;
  if (!isStaging(env)) return response({ ok: false, error: "not_found" }, 404);
  if (req.method !== "POST") return response({ ok: false, error: "method_not_allowed" }, 405);
  if (!(await authorize(req, env))) return response({ ok: false, error: "unauthorized" }, 401);
  if (!env.VBC_REGISTRY || !env.AUDIT_ARCHIVE) {
    return response({ ok: false, error: "vbc_registry_or_archive_binding_unavailable" }, 503);
  }

  let body: any;
  try {
    body = await readBoundedJson(req);
  } catch (error) {
    const message = String((error as Error)?.message || error);
    return response({ ok: false, error: message === "body_too_large" ? message : "invalid_json" }, message === "body_too_large" ? 413 : 400);
  }

  if (path === RUNS_PATH) {
    if (!validateRunBody(body)) return response({ ok: false, error: "invalid_audit_run_schema" }, 400);
    const now = new Date().toISOString();
    const runId = crypto.randomUUID();
    try {
      await env.VBC_REGISTRY.prepare(
        `INSERT INTO audit_runs
          (run_id, tenant_id, suite_name, suite_version, status, created_at, started_at,
           software_hash, target_commit, expected_test_count)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`
      ).bind(runId, body.tenant_id, body.suite_name, body.suite_version, now, now,
        body.software_hash, body.target_commit, body.expected_test_count).run();
      return response({ ok: true, run_id: runId, status: "running", created_at: now }, 201);
    } catch {
      return response({ ok: false, error: "audit_run_persistence_failed" }, 503);
    }
  }

  const match = path.match(/^\/v1\/vbc\/runs\/([a-f0-9-]{36})\/(results|finalize)$/);
  if (!match || !RUN_ID_RE.test(match[1])) return response({ ok: false, error: "not_found" }, 404);
  const runId = match[1];
  const action = match[2];

  const runResult = await env.VBC_REGISTRY.prepare(
    "SELECT * FROM audit_runs WHERE run_id = ? LIMIT 1"
  ).bind(runId).first<AuditRun>();
  if (!runResult) return response({ ok: false, error: "audit_run_not_found" }, 404);
  if (runResult.status !== "running") return response({ ok: false, error: "audit_run_not_running" }, 409);

  if (action === "results") {
    if (!Array.isArray(body.results) || body.results.length < 1 || body.results.length > 100) {
      return response({ ok: false, error: "invalid_test_results_batch" }, 400);
    }
    const statements: D1PreparedStatement[] = [];
    for (const item of body.results) {
      if (!item || typeof item.test_name !== "string" || !TEST_NAME_RE.test(item.test_name) ||
          !Number.isInteger(item.status_http) || item.status_http < 100 || item.status_http > 599 ||
          typeof item.passed !== "boolean" || item.details === undefined) {
        return response({ ok: false, error: "invalid_test_result", test_name: item?.test_name ?? null }, 400);
      }
      const resultJson = canonicalJson(item.details);
      if (resultJson.length > 16_384) return response({ ok: false, error: "test_evidence_too_large" }, 413);
      const evidenceHash = await sha256Hex(resultJson);
      statements.push(env.VBC_REGISTRY.prepare(
        `INSERT INTO test_results
          (result_id, run_id, test_name, status_http, passed, result_json, evidence_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), runId, item.test_name, item.status_http,
        item.passed ? 1 : 0, resultJson, evidenceHash, new Date().toISOString()));
    }
    try {
      await env.VBC_REGISTRY.batch(statements);
      return response({ ok: true, run_id: runId, accepted_results: statements.length });
    } catch {
      return response({ ok: false, error: "test_results_persistence_failed_or_duplicate" }, 409);
    }
  }

  const testsResult = await env.VBC_REGISTRY.prepare(
    "SELECT * FROM test_results WHERE run_id = ? ORDER BY test_name ASC"
  ).bind(runId).all<TestResult>();
  const tests = testsResult.results || [];
  const passedCount = tests.filter((test) => test.passed === 1).length;
  const failedCount = tests.length - passedCount;
  const finishedAt = new Date().toISOString();

  if (tests.length !== runResult.expected_test_count) {
    return response({
      ok: false,
      error: "test_inventory_incomplete",
      expected: runResult.expected_test_count,
      recorded: tests.length,
    }, 409);
  }

  if (failedCount > 0) {
    await env.VBC_REGISTRY.prepare(
      "UPDATE audit_runs SET status = 'failed', finished_at = ?, passed_test_count = ?, failed_test_count = ? WHERE run_id = ? AND status = 'running'"
    ).bind(finishedAt, passedCount, failedCount, runId).run();
    return response({ ok: false, error: "audit_run_failed", passed: passedCount, failed: failedCount }, 409);
  }

  const finalizedRun: AuditRun = { ...runResult, status: "succeeded", finished_at: finishedAt };
  const built = await buildEvidenceManifest({ run: finalizedRun, tests });
  const manifestKey = `vbc/manifests/${runId}/${built.sha256}.json`;
  const manifestId = crypto.randomUUID();

  try {
    await env.AUDIT_ARCHIVE.put(manifestKey, built.canonical, {
      httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "no-store" },
      customMetadata: {
        run_id: runId,
        sha256: built.sha256,
        schema: "aston.vbc.evidence-manifest/1.0.0",
      },
    });

    const results = await env.VBC_REGISTRY.batch([
      env.VBC_REGISTRY.prepare(
        `UPDATE audit_runs
         SET status = 'succeeded', finished_at = ?, passed_test_count = ?, failed_test_count = 0,
             manifest_sha256 = ?, manifest_key = ?
         WHERE run_id = ? AND status = 'running'`
      ).bind(finishedAt, passedCount, built.sha256, manifestKey, runId),
      env.VBC_REGISTRY.prepare(
        `INSERT INTO evidence_manifest
          (manifest_id, run_id, manifest_version, evidence_hash, timestamp, manifest_json, object_key)
         SELECT ?, ?, '1.0.0', ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM audit_runs
           WHERE run_id = ? AND status = 'succeeded' AND manifest_sha256 = ?
         )`
      ).bind(manifestId, runId, built.sha256, finishedAt, built.canonical, manifestKey, runId, built.sha256),
    ]);
    const updateChanges = results[0]?.meta?.changes ?? 0;
    const manifestChanges = results[1]?.meta?.changes ?? 0;
    if (updateChanges !== 1 || manifestChanges !== 1) {
      return response({ ok: false, error: "audit_finalization_race_or_persistence_failure" }, 409);
    }
    return response({
      ok: true,
      run_id: runId,
      status: "succeeded",
      manifest: {
        schema_version: "1.0.0",
        sha256: built.sha256,
        r2_key: manifestKey,
        graph_nodes: built.manifest.graph.nodes.length,
        graph_edges: built.manifest.graph.edges.length,
        verification: built.manifest.verification,
      },
    }, 201);
  } catch {
    return response({ ok: false, error: "manifest_persistence_failed" }, 503);
  }
}

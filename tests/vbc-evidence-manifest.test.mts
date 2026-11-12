import test from "node:test";
import assert from "node:assert/strict";
import { buildEvidenceManifest, canonicalJson } from "../src/vbc/evidence-manifest.ts";

const run = {
  run_id: "123e4567-e89b-42d3-a456-426614174000",
  tenant_id: "tenant-staging",
  suite_name: "ARP-100",
  suite_version: "1.0.0",
  status: "succeeded" as const,
  created_at: "2026-11-11T10:00:00.000Z",
  started_at: "2026-11-11T10:00:00.000Z",
  finished_at: "2026-11-11T10:01:00.000Z",
  software_hash: "a".repeat(64),
  target_commit: "b".repeat(40),
  expected_test_count: 1,
};

const testResult = {
  result_id: "223e4567-e89b-42d3-a456-426614174000",
  run_id: run.run_id,
  test_name: "cloudflare.typescript",
  status_http: 200,
  passed: 1,
  result_json: '{"conclusion":"success","tool":"tsc"}',
  evidence_sha256: "c".repeat(64),
  created_at: "2026-11-11T10:00:30.000Z",
};

test("canonical JSON sorts object keys recursively and preserves arrays", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [2, 1] }),
    '{"a":{"b":3,"y":2},"list":[2,1],"z":1}',
  );
});

test("manifest contains run, software, test and evidence provenance graph", async () => {
  const built = await buildEvidenceManifest({ run, tests: [testResult] });
  assert.match(built.sha256, /^[a-f0-9]{64}$/);
  assert.equal(built.manifest.graph.nodes.length, 4);
  assert.equal(built.manifest.graph.edges.length, 3);
  assert.equal(built.manifest.audit.passed_test_count, 1);
  assert.equal(built.manifest.verification.pdf_signature, "not_implemented");
  assert.equal(built.manifest.verification.bitcoin_ots, "not_anchored");
  assert.equal(built.canonical, canonicalJson(built.manifest));
});

test("manifest digest is stable for identical immutable run and evidence input", async () => {
  const first = await buildEvidenceManifest({ run, tests: [testResult] });
  const second = await buildEvidenceManifest({ run, tests: [testResult] });
  assert.equal(first.sha256, second.sha256);
});

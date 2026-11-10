import test from "node:test";
import assert from "node:assert/strict";
import { writeImmutableCheckpoint, verifyExternalOtsAnchor, type AuditCheckpoint } from "../src/security/audit-anchor.ts";

function fakeBucket(initial = new Map<string, { body: string; customMetadata: Record<string, string> }>()) {
  const objects = initial;
  return {
    objects,
    async head(key: string) {
      const value = objects.get(key);
      return value ? { customMetadata: value.customMetadata } : null;
    },
    async get(key: string) {
      const value = objects.get(key);
      if (!value) return null;
      return {
        async text() { return value.body; },
        async json<T>() { return JSON.parse(value.body) as T; },
        async arrayBuffer() { return new TextEncoder().encode(value.body).buffer; },
      };
    },
    async put(key: string, body: string, options: any) {
      if (objects.has(key)) throw new Error("already_exists");
      objects.set(key, { body, customMetadata: options.customMetadata });
      return {};
    },
  } as unknown as R2Bucket & { objects: typeof objects };
}

const checkpoint: AuditCheckpoint = {
  schema: "aston.audit.checkpoint.v1",
  tenant_hash: "a".repeat(64),
  event_count: 100,
  root_hash: "b".repeat(64),
  previous_anchor_root: "GENESIS",
  first_event_hash: "c".repeat(64),
  last_event_hash: "b".repeat(64),
  last_event_ts: 1794300000000,
  created_at: 1794300000000,
};

test("writes deterministic immutable R2 checkpoint with root metadata", async () => {
  const bucket = fakeBucket();
  const first = await writeImmutableCheckpoint(bucket, checkpoint);
  const second = await writeImmutableCheckpoint(bucket, checkpoint);
  assert.equal(first.key, second.key);
  assert.equal(bucket.objects.size, 1);
  assert.equal(bucket.objects.get(first.key)?.customMetadata.root_hash, checkpoint.root_hash);
});

test("rejects a checkpoint key whose stored metadata or body was replaced", async () => {
  const bucket = fakeBucket();
  const first = await writeImmutableCheckpoint(bucket, checkpoint);
  bucket.objects.set(first.key, { body: "tampered", customMetadata: { root_hash: checkpoint.root_hash, event_count: "100" } });
  await assert.rejects(() => writeImmutableCheckpoint(bucket, checkpoint), /content_mismatch/);
});

test("fails closed when OTS receipt is absent", async () => {
  const bucket = fakeBucket();
  const { key } = await writeImmutableCheckpoint(bucket, checkpoint);
  const verifier = { fetch: async () => new Response(JSON.stringify({ ok: true, confirmed: true, root_hash: checkpoint.root_hash, block_height: 900000 })) } as unknown as Fetcher;
  const result = await verifyExternalOtsAnchor(verifier, bucket, key, checkpoint.root_hash);
  assert.deepEqual(result, { ok: false, confirmed: false, reason: "ots_proof_pending" });
});

test("accepts only a verifier-confirmed proof for the exact root", async () => {
  const bucket = fakeBucket();
  const { key } = await writeImmutableCheckpoint(bucket, checkpoint);
  const proofKey = key.replace("audit/anchors/v1/", "audit/ots/v1/").replace(/\.json$/, ".ots");
  bucket.objects.set(proofKey, { body: "proof-fixture", customMetadata: {} });
  let requestBody: any;
  const verifier = {
    async fetch(_url: string, init: RequestInit) {
      requestBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true, confirmed: true, root_hash: checkpoint.root_hash, block_height: 900000 }));
    },
  } as unknown as Fetcher;
  const result = await verifyExternalOtsAnchor(verifier, bucket, key, checkpoint.root_hash);
  assert.deepEqual(result, { ok: true, confirmed: true, block_height: 900000, timestamp: undefined });
  assert.equal(requestBody.checkpoint.root_hash, checkpoint.root_hash);
  assert.ok(requestBody.proof_base64);
});

test("rejects a verifier response for a different root", async () => {
  const bucket = fakeBucket();
  const { key } = await writeImmutableCheckpoint(bucket, checkpoint);
  const proofKey = key.replace("audit/anchors/v1/", "audit/ots/v1/").replace(/\.json$/, ".ots");
  bucket.objects.set(proofKey, { body: "proof-fixture", customMetadata: {} });
  const verifier = {
    fetch: async () => new Response(JSON.stringify({ ok: true, confirmed: true, root_hash: "d".repeat(64), block_height: 900000 })),
  } as unknown as Fetcher;
  const result = await verifyExternalOtsAnchor(verifier, bucket, key, checkpoint.root_hash);
  assert.deepEqual(result, { ok: false, confirmed: false, reason: "ots_proof_not_confirmed_or_invalid" });
});

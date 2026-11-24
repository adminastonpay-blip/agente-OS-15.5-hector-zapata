import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeJson,
  importEd25519PrivateKey,
  importEd25519PublicKey,
  sha256Hex,
  signAttestation,
  verifyAttestation,
} from "../src/core/attestation.ts";

test("canonical JSON sorts object keys and is stable", () => {
  assert.equal(canonicalizeJson({ z: 1, a: { y: true, b: 2 } }), '{"a":{"b":2,"y":true},"z":1}');
  assert.equal(canonicalizeJson({ n: -0 }), '{"n":0}');
});

test("canonical JSON rejects values outside the signed JSON data model", () => {
  assert.throws(() => canonicalizeJson({ value: undefined }), /attestation_undefined_value/);
  assert.throws(() => canonicalizeJson({ value: Number.NaN }), /attestation_non_finite_number/);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => canonicalizeJson(circular), /attestation_circular_reference/);
});

test("SHA-256 produces a stable lowercase digest", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("Ed25519 attestation signs canonical payload and rejects tampering", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateKey = await importEd25519PrivateKey(pkcs8);
  const publicKey = await importEd25519PublicKey(rawPublic);

  const envelope = await signAttestation(
    { z: "last", a: "first" },
    privateKey,
    "aston-test-key-1",
    "attestation-test-1",
    "2026-11-24T00:00:00.000Z",
  );
  assert.equal(envelope.algorithm, "Ed25519");
  assert.equal(envelope.transparency.anchor_status, "not_submitted");
  assert.equal(await verifyAttestation(envelope, publicKey), true);

  const tampered = { ...envelope, payload: { z: "changed", a: "first" } };
  assert.equal(await verifyAttestation(tampered, publicKey), false);
  const changedKeyId = { ...envelope, key_id: "attacker-selected-key" };
  assert.equal(await verifyAttestation(changedKeyId, publicKey), false);
  const changedTimestamp = { ...envelope, signed_at: "2026-11-25T00:00:00.000Z" };
  assert.equal(await verifyAttestation(changedTimestamp, publicKey), false);
  const forgedAnchor = { ...envelope, transparency: { anchor_status: "anchored" as const } };
  assert.equal(await verifyAttestation(forgedAnchor, publicKey), false);
});

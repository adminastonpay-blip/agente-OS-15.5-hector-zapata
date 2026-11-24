import test from "node:test";
import assert from "node:assert/strict";
import { assertCryptographicReadiness, ControlAssuranceError } from "../../src/core/control-assurance.ts";

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g, "").replace(/[+]/g, "-").replace(/[/]/g, "_");
}
async function makePair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return {
    privateKey: base64url(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: base64url(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}
const trust = {} as DurableObjectNamespace;

test("AST-CA-003: missing TRUST binding returns 503", async () => {
  const keys = await makePair();
  await assert.rejects(assertCryptographicReadiness({
    TRUST: undefined, ATTESTATION_PRIVATE_KEY: keys.privateKey,
    ATTESTATION_PUBLIC_KEY: keys.publicKey, ATTESTATION_KEY_ID: "test-key",
  }), (error: unknown) => error instanceof ControlAssuranceError &&
    error.statusCode === 503 && error.code === "TRUST_BINDING_MISSING");
});

test("AST-CA-003: missing private/public key material returns 503", async () => {
  const keys = await makePair();
  await assert.rejects(assertCryptographicReadiness({
    TRUST: trust, ATTESTATION_PUBLIC_KEY: keys.publicKey, ATTESTATION_KEY_ID: "test-key",
  }), (error: unknown) => error instanceof ControlAssuranceError && error.code === "ATTESTATION_KEYS_MISSING");
  await assert.rejects(assertCryptographicReadiness({
    TRUST: trust, ATTESTATION_PRIVATE_KEY: keys.privateKey, ATTESTATION_KEY_ID: "test-key",
  }), (error: unknown) => error instanceof ControlAssuranceError && error.code === "ATTESTATION_KEYS_MISSING");
});

test("AST-CA-003: malformed and mismatched Ed25519 keys return 503", async () => {
  const a = await makePair();
  const b = await makePair();
  await assert.rejects(assertCryptographicReadiness({
    TRUST: trust, ATTESTATION_PRIVATE_KEY: a.privateKey,
    ATTESTATION_PUBLIC_KEY: b.publicKey, ATTESTATION_KEY_ID: "mismatch",
  }), (error: unknown) => error instanceof ControlAssuranceError &&
    error.statusCode === 503 && error.code === "ATTESTATION_KEYPAIR_INVALID");
  await assert.rejects(assertCryptographicReadiness({
    TRUST: trust, ATTESTATION_PRIVATE_KEY: "not-base64url!",
    ATTESTATION_PUBLIC_KEY: a.publicKey, ATTESTATION_KEY_ID: "malformed",
  }), (error: unknown) => error instanceof ControlAssuranceError && error.statusCode === 503);
});

test("AST-CA-003: valid TRUST binding and matching Ed25519 pair pass readiness", async () => {
  const keys = await makePair();
  await assert.doesNotReject(assertCryptographicReadiness({
    TRUST: trust, ATTESTATION_PRIVATE_KEY: keys.privateKey,
    ATTESTATION_PUBLIC_KEY: keys.publicKey, ATTESTATION_KEY_ID: "test-key",
  }));
});

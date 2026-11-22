import test from "node:test";
import assert from "node:assert/strict";
import { isOutputSafeForCredentialLeak } from "../src/safety/chat-output-guard.ts";
import { isStagingRouteAllowed } from "../src/audit/staging-route-guard.ts";

test("allows ordinary Spanish chat responses", () => {
  assert.equal(isOutputSafeForCredentialLeak("Hola. ¿En qué puedo ayudarte hoy?"), true);
});
test("blocks PEM private-key headers", () => {
  assert.equal(isOutputSafeForCredentialLeak("-----BEGIN PRIVATE KEY-----\\nabc"), false);
});
test("blocks AWS access-key identifiers", () => {
  // Construct a synthetic key at runtime so secret scanners do not mistake the fixture for a credential.
  const syntheticAwsKey = ["AKIA", "1234567890ABCDEF"].join("");
  assert.equal(isOutputSafeForCredentialLeak(`Credencial: ${syntheticAwsKey}`), false);
});
test("blocks long bearer tokens", () => {
  assert.equal(isOutputSafeForCredentialLeak("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"), false);
});
test("blocks long secret-key-like tokens", () => {
  assert.equal(isOutputSafeForCredentialLeak("sk-abcdefghijklmnopqrstuvwxyz123456"), false);
});
test("does not reject short ordinary identifiers", () => {
  assert.equal(isOutputSafeForCredentialLeak("La referencia es sk-1234 y el pedido 456."), true);
});

test("keeps production routing unchanged", () => {
  assert.equal(isStagingRouteAllowed("21.6.3-cf-audit", "/v1/tts"), true);
});
test("audit staging allows only health and explicitly approved audit routes", () => {
  const profile = "21.6.3-audit-staging";
  for (const path of ["/", "/health", "/v1/audit-target", "/v1/audit-target/", "/v1/audit/anchor/verify"]) {
    assert.equal(isStagingRouteAllowed(profile, path), true, `expected ${path} to be allowed`);
  }
  for (const path of ["/chat", "/v1/tts", "/v1/validate", "/v1/etl/ingest", "/v1/rag/ingest", "/v1/rag/query", "/v1/solve"]) {
    assert.equal(isStagingRouteAllowed(profile, path), false, `expected ${path} to be denied`);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { isOutputSafeForCredentialLeak } from "../src/safety/chat-output-guard.ts";
import { isStagingRouteAllowed } from "../src/audit/staging-route-guard.ts";

test("allows ordinary Spanish chat responses", () => {
  assert.equal(isOutputSafeForCredentialLeak("Hola. ¿En qué puedo ayudarte hoy?"), true);
});
test("blocks PEM private-key headers", () => {
  assert.equal(isOutputSafeForCredentialLeak("-----BEGIN PRIVATE KEY-----\nabc"), false);
});
test("blocks AWS access-key identifiers", () => {
  // Construct a synthetic key at runtime so secret scanners do not mistake the test fixture for a credential.
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
test("allows only health and authenticated audit routes in staging", () => {
  assert.equal(isStagingRouteAllowed("21.6.3-audit-staging", "/"), true);
  assert.equal(isStagingRouteAllowed("21.6.3-audit-staging", "/health"), true);
  assert.equal(isStagingRouteAllowed("21.6.3-audit-staging", "/v1/audit-target"), true);
  assert.equal(isStagingRouteAllowed("21.6.3-audit-staging", "/v1/audit-target/"), true);
  assert.equal(isStagingRouteAllowed("21.6.3-audit-staging", "/chat"), false);
  assert.equal(isStagingRouteAllowed("21.6.3-audit-staging", "/v1/tts"), false);
  assert.equal(isStagingRouteAllowed("21.6.3-audit-staging", "/v1/validate"), false);
});

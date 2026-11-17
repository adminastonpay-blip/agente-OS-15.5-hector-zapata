import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedRecoveryOrigin } from "../src/security/recovery-guard.ts";

test("allows HTTPS probes only for an explicitly configured origin", () => {
  assert.equal(
    isAllowedRecoveryOrigin("https://api.example.test/health", "https://api.example.test"),
    true
  );
});

test("rejects missing or empty allowlists", () => {
  assert.equal(isAllowedRecoveryOrigin("https://api.example.test", undefined), false);
  assert.equal(isAllowedRecoveryOrigin("https://api.example.test", " "), false);
});

test("rejects unlisted origins and HTTP", () => {
  assert.equal(
    isAllowedRecoveryOrigin("https://other.example.test/health", "https://api.example.test"),
    false
  );
  assert.equal(
    isAllowedRecoveryOrigin("http://api.example.test/health", "https://api.example.test"),
    false
  );
});

test("rejects malformed URLs and embedded credentials", () => {
  assert.equal(isAllowedRecoveryOrigin("not-a-url", "https://api.example.test"), false);
  assert.equal(
    isAllowedRecoveryOrigin("https://user:pass@api.example.test/health", "https://api.example.test"),
    false
  );
});

test("allowlist entries must be origins, not paths or query strings", () => {
  assert.equal(
    isAllowedRecoveryOrigin("https://api.example.test/health", "https://api.example.test/health"),
    false
  );
});

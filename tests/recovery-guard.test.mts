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

test("blocks a 302 redirect and never follows its Location target", async () => {
  const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const { probeRecoveryOrigin } = await import("../src/security/recovery-guard.ts");
  const result = await probeRecoveryOrigin(
    "https://api.example.test/health",
    "https://api.example.test",
    async (input, init) => {
      calls.push({ url: String(input), redirect: init?.redirect });
      assert.equal(init?.redirect, "error");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://169.254.169.254/latest/meta-data/" },
      });
    }
  );
  assert.equal(result.reachable, false);
  assert.equal(result.blocked, "redirect_blocked");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/health");
});

test("redirect fetch failure is contained as a blocked probe", async () => {
  const { probeRecoveryOrigin } = await import("../src/security/recovery-guard.ts");
  const result = await probeRecoveryOrigin(
    "https://api.example.test/health",
    "https://api.example.test",
    async (_input, init) => {
      assert.equal(init?.redirect, "error");
      throw new TypeError("redirect mode error");
    }
  );
  assert.equal(result.reachable, false);
  assert.equal(result.blocked, "probe_failed_or_redirect_blocked");
});

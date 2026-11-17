import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/do/mission-brain.ts", import.meta.url), "utf8");

test("MissionBrain does not invoke an AI model outside the safety gate", () => {
  assert.doesNotMatch(source, /\b(?:ai|AI)\.run\s*\(/);
});

test("MissionBrain cannot mutate Cloudflare load balancer pools", () => {
  assert.doesNotMatch(source, /api\.cloudflare\.com\/client\/v4\/accounts/);
  assert.doesNotMatch(source, /method:\s*["']PATCH["']/i);
  assert.match(source, /manual_action_required/);
});

test("MissionBrain has no remaining unguarded verification probe", () => {
  assert.doesNotMatch(source, /private async verify\(/);
});

test("MissionBrain blocks recovery probes unless origin is allowlisted", () => {
  assert.match(source, /isAllowedRecoveryOrigin\(m\.origin, this\.env\.RECOVERY_ALLOWED_ORIGINS\)/);
  assert.match(source, /origin_not_allowlisted/);
});

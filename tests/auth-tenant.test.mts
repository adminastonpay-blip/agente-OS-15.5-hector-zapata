import test from "node:test";
import assert from "node:assert/strict";
import { resolveTenantClaim } from "../src/auth.ts";

test("preserves an explicit validated tenant claim", () => {
  assert.equal(resolveTenantClaim("tenant-company-a", "actorhash"), "tenant-company-a");
});

test("isolates users with missing tenant claims instead of assigning a shared default", () => {
  assert.equal(resolveTenantClaim(undefined, "actorhash-a"), "unassigned-actorhash-a");
  assert.equal(resolveTenantClaim(undefined, "actorhash-b"), "unassigned-actorhash-b");
  assert.notEqual(resolveTenantClaim(undefined, "actorhash-a"), resolveTenantClaim(undefined, "actorhash-b"));
});

test("isolates malformed tenant claims using the verified actor fingerprint", () => {
  assert.equal(resolveTenantClaim("bad tenant value", "verified-user"), "unassigned-verified-user");
});

import test from "node:test";
import assert from "node:assert/strict";
import { isExplicitAccessAllow } from "../src/access/access.ts";

test("only the exact allow effect is an authorization grant", () => {
  assert.equal(isExplicitAccessAllow("allow"), true);
  assert.equal(isExplicitAccessAllow("deny"), false);
  assert.equal(isExplicitAccessAllow("require_approval"), false);
  assert.equal(isExplicitAccessAllow(undefined), false);
  assert.equal(isExplicitAccessAllow(null), false);
  assert.equal(isExplicitAccessAllow("approved"), false);
});

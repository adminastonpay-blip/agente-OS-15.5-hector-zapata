import test from "node:test";
import assert from "node:assert/strict";
import { sessionStorageKey } from "../src/security/session-key.ts";
import type { Identity } from "../src/types";

const base: Identity = {
  actor: "alice@example.test", method: "access", tenant: "tenant-a",
  roles: ["viewer"], clearance: "internal", plan: "pro",
};

test("same verified identity and session maps to a stable storage key", async () => {
  assert.equal(await sessionStorageKey(base, "session-1"), await sessionStorageKey(base, "session-1"));
});

test("different actors cannot share a session namespace", async () => {
  const alice = await sessionStorageKey(base, "session-1");
  const bob = await sessionStorageKey({ ...base, actor: "bob@example.test" }, "session-1");
  assert.notEqual(alice, bob);
});

test("different tenants cannot share a session namespace", async () => {
  const tenantA = await sessionStorageKey(base, "session-1");
  const tenantB = await sessionStorageKey({ ...base, tenant: "tenant-b" }, "session-1");
  assert.notEqual(tenantA, tenantB);
});

test("different session identifiers remain isolated", async () => {
  assert.notEqual(await sessionStorageKey(base, "session-1"), await sessionStorageKey(base, "session-2"));
});

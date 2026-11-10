import test from "node:test";
import assert from "node:assert/strict";
import { enforceRequestBodyLimit, rateLimitPolicy } from "../src/security/request-guard.ts";
import type { Identity } from "../src/types";

const free: Identity = {
  actor: "public", method: "public", tenant: "public",
  roles: ["viewer"], clearance: "public", plan: "free",
};

test("rejects a declared body larger than the plan limit", async () => {
  const req = new Request("https://aston.example/v1/chat", {
    method: "POST",
    headers: { "content-length": String(64 * 1024 + 1) },
    body: "x",
  });
  const result = await enforceRequestBodyLimit(req, free);
  assert.equal(result.result.ok, false);
});

test("enforces actual streamed bytes when content length is absent", async () => {
  const payload = new Uint8Array(64 * 1024 + 1);
  const req = new Request("https://aston.example/v1/chat", {
    method: "POST",
    body: payload,
  });
  const result = await enforceRequestBodyLimit(req, free);
  assert.equal(result.result.ok, false);
});

test("replays a bounded request body for downstream route handlers", async () => {
  const req = new Request("https://aston.example/v1/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hola" }),
  });
  const result = await enforceRequestBodyLimit(req, free);
  assert.equal(result.result.ok, true);
  assert.deepEqual(await result.request.json(), { message: "hola" });
});

test("applies tighter public chat limits than authenticated chat", () => {
  assert.equal(rateLimitPolicy("/v1/chat", "POST", free).limit, 8);
  assert.equal(rateLimitPolicy("/v1/chat", "POST", { ...free, method: "access", plan: "pro" }).limit, 30);
});

test("uses a separate authenticated read/write rate policy", () => {
  const authenticated = { ...free, method: "access" as const, tenant: "tenant-a" };
  assert.equal(rateLimitPolicy("/v1/status", "GET", authenticated).limit, 120);
  assert.equal(rateLimitPolicy("/v1/action", "POST", authenticated).limit, 40);
});

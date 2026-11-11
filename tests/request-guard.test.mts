import test from "node:test";
import assert from "node:assert/strict";
import { checkRequestRateLimit, enforceRequestBodyLimit, rateLimitPolicy } from "../src/security/request-guard.ts";
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
  assert.equal(rateLimitPolicy("/v1/status", "GET", authenticated).bucket, "authenticated-read");
  assert.equal(rateLimitPolicy("/v1/status", "GET", authenticated).limit, 120);
  assert.equal(rateLimitPolicy("/v1/action", "POST", authenticated).bucket, "authenticated-write");
  assert.equal(rateLimitPolicy("/v1/action", "POST", authenticated).limit, 40);
});

test("blocks the ninth public chat request in a one-minute window", async () => {
  const counts = new Map<string, number>();
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const count = (counts.get(id) || 0) + 1;
        counts.set(id, count);
        const allowed = count <= body.limit;
        return Response.json({
          allowed,
          remaining: Math.max(0, body.limit - count),
          reset_at: Date.now() + body.window_ms,
        }, { status: allowed ? 200 : 429 });
      },
    }),
  };
  const env = { SAFETY: namespace } as any;
  for (let i = 0; i < 8; i++) {
    const result = await checkRequestRateLimit(env, free, "/v1/chat", "POST", "192.0.2.10");
    assert.equal(result.allowed, true);
  }
  const blocked = await checkRequestRateLimit(env, free, "/v1/chat", "POST", "192.0.2.10");
  assert.equal(blocked.allowed, false);
  assert.equal("unavailable" in blocked, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { handleV21 } from "../src/routes/v21.ts";

const identity = {
  actor: "operator-a",
  method: "access" as const,
  tenant: "tenant-a",
  roles: ["admin"],
  clearance: "public" as const,
};

async function call(secret?: string) {
  const response = await handleV21(
    "/v1/pii/mask",
    new Request("https://aston.test/v1/pii/mask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "contact user@example.com", clearance: "public" }),
    }),
    { PII_HMAC_SECRET: secret } as any,
    identity,
    (body, status = 200) => Response.json(body, { status }),
  );
  assert.ok(response);
  return response;
}

test("PII masking fails closed when the HMAC secret is absent", async () => {
  const response = await call(undefined);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "pii_hmac_secret_not_configured",
  });
});

test("PII masking rejects an undersized HMAC secret", async () => {
  const response = await call("short-secret");
  assert.equal(response.status, 503);
});

test("PII masking works with a configured secret of at least 32 characters", async () => {
  const response = await call("test-secret-0123456789-abcdefghijk");
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.ok, true);
  assert.match(body.masked, /⟦EMAIL_[a-f0-9]{12}⟧/);
  assert.equal(body.masked.includes("user@example.com"), false);
});

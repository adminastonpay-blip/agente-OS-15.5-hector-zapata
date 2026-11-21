import test from "node:test";
import assert from "node:assert/strict";
import { handleEngineeringHealth, handleShopifyPublic } from "../src/routes/shopify-public.ts";

const publicRequest = (path: string, method = "GET", body?: unknown) =>
  new Request("https://api.aston.example" + path, {
    method,
    headers: {
      Origin: "https://m1m0d3-ru.myshopify.com",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const publicEnv = (overrides: Record<string, unknown> = {}) => ({
  SHOPIFY_ALLOWED_ORIGINS: "https://m1m0d3-ru.myshopify.com",
  ...overrides,
});

test("public health returns only sanitized D1 probe metadata", async () => {
  const env = publicEnv({
    DB: { prepare: () => ({ first: async () => ({ probe: 1 }) }) },
  });
  const result = await handleShopifyPublic("/v1/public/health", publicRequest("/v1/public/health"), env as any);
  assert.equal(result?.status, 200);
  const body = await result!.json() as any;
  assert.equal(body.status, "healthy");
  assert.equal(body.ok, true);
  assert.equal(typeof body.latency_ms, "number");
  assert.equal("database_id" in body, false);
});

test("public health fails closed when D1 is not bound", async () => {
  const result = await handleShopifyPublic("/v1/public/health", publicRequest("/v1/public/health"), publicEnv() as any);
  assert.equal(result?.status, 503);
  assert.equal((await result!.json() as any).status, "unconfigured");
});

test("public health does not disclose raw D1 exceptions", async () => {
  const env = publicEnv({
    DB: { prepare: () => ({ first: async () => { throw new Error("private-db-secret"); } }) },
  });
  const result = await handleShopifyPublic("/v1/public/health", publicRequest("/v1/public/health"), env as any);
  assert.equal(result?.status, 503);
  assert.doesNotMatch(await result!.text(), /private-db-secret/);
});

test("public routes reject unlisted origins", async () => {
  const req = new Request("https://api.aston.example/v1/public/health", {
    headers: { Origin: "https://attacker.example" },
  });
  const result = await handleShopifyPublic("/v1/public/health", req, publicEnv() as any);
  assert.equal(result?.status, 403);
});

test("CISO lead intake fails closed until Turnstile, encryption and D1 are configured", async () => {
  const result = await handleShopifyPublic(
    "/v1/public/leads/ciso",
    publicRequest("/v1/public/leads/ciso", "POST", {}),
    publicEnv() as any,
  );
  assert.equal(result?.status, 503);
  assert.equal((await result!.json() as any).error, "lead_intake_not_configured");
});

test("engineering health is private and denies public identity", async () => {
  const identity = { actor: "public", method: "public", tenant: "public", roles: ["viewer"], clearance: "public" };
  const result = await handleEngineeringHealth(
    "/v1/engineering/health",
    publicRequest("/v1/engineering/health"),
    { DB: { prepare: () => ({ first: async () => ({ probe: 1 }) }) } } as any,
    identity as any,
  );
  assert.equal(result?.status, 403);
});

test("engineering health allows authenticated executor and performs a real probe", async () => {
  let probes = 0;
  const identity = { actor: "operator", method: "access", tenant: "aston", roles: ["executor"], clearance: "internal" };
  const result = await handleEngineeringHealth(
    "/v1/engineering/health",
    publicRequest("/v1/engineering/health"),
    { DB: { prepare: (sql: string) => ({ first: async () => { assert.equal(sql, "SELECT 1 AS probe"); probes++; return { probe: 1 }; } }) } } as any,
    identity as any,
  );
  assert.equal(result?.status, 200);
  assert.equal(probes, 1);
});

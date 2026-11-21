import test from "node:test";
import assert from "node:assert/strict";
import { handleEngineeringCisoLeads, handleEngineeringHealth, handleShopifyPublic } from "../src/routes/shopify-public.ts";

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

test("CISO lead intake verifies Turnstile and stores encrypted PII only", async () => {
  const originalFetch = globalThis.fetch;
  let inserted: unknown[] | null = null;
  let verificationCalls = 0;
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    verificationCalls++;
    const params = new URLSearchParams(String(init?.body || ""));
    assert.equal(params.get("secret"), "turnstile-secret");
    assert.equal(params.get("response"), "valid-token");
    return Response.json({
      success: true,
      hostname: "m1m0d3-ru.myshopify.com",
      action: "aston_ciso_lead",
    });
  };
  try {
    const rawKey = new Uint8Array(32).fill(19);
    const key = btoa(String.fromCharCode(...rawKey)).split("+").join("-").split("/").join("_").replace(/=+$/g, "");
    const env = publicEnv({
      DB: {
        prepare: (sql: string) => {
          assert.match(sql, /INSERT INTO ciso_leads/);
          return {
            bind: (...values: unknown[]) => {
              inserted = values;
              return { run: async () => ({ success: true, meta: { changes: 1 } }) };
            },
          };
        },
      },
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      LEADS_ENCRYPTION_KEY: key,
    });
    const req = publicRequest("/v1/public/leads/ciso", "POST", {
      name: "CISO Example",
      email: "security@example.com",
      company: "Example Corp",
      role: "CISO",
      interest: "ASTON CONTROL",
      message: "Solicito una demostración",
      consent: true,
      turnstile_token: "valid-token",
    });
    const result = await handleShopifyPublic("/v1/public/leads/ciso", req, env as any);
    assert.equal(result?.status, 202);
    assert.equal(verificationCalls, 1);
    assert.ok(inserted);
    assert.equal((inserted as unknown[]).length, 7);
    assert.doesNotMatch(String((inserted as unknown[])[1]), /security@example.com/);
    assert.doesNotMatch(String((inserted as unknown[])[2]), /security@example.com|CISO Example|Example Corp/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CISO lead intake rejects Turnstile responses for a different hostname", async () => {
  const originalFetch = globalThis.fetch;
  let inserts = 0;
  globalThis.fetch = async () => Response.json({
    success: true,
    hostname: "attacker.example",
    action: "aston_ciso_lead",
  });
  try {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(3))).split("+").join("-").split("/").join("_").replace(/=+$/g, "");
    const env = publicEnv({
      DB: { prepare: () => ({ bind: () => ({ run: async () => { inserts++; } }) }) },
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      LEADS_ENCRYPTION_KEY: key,
    });
    const result = await handleShopifyPublic("/v1/public/leads/ciso", publicRequest("/v1/public/leads/ciso", "POST", {
      name: "CISO Example", email: "security@example.com", company: "Example Corp",
      consent: true, turnstile_token: "valid-token",
    }), env as any);
    assert.equal(result?.status, 403);
    assert.equal(inserts, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CISO lead inbox denies executor and non-admin identities", async () => {
  const executor = { actor: "operator", method: "access", tenant: "aston", roles: ["executor"], clearance: "internal" };
  const result = await handleEngineeringCisoLeads(
    "/v1/engineering/leads/ciso",
    new Request("https://api.aston.example/v1/engineering/leads/ciso"),
    { DB: {} } as any,
    executor as any,
  );
  assert.equal(result?.status, 403);
});

test("CISO lead inbox decrypts records only for verified admin", async () => {
  const raw = new Uint8Array(32).fill(23);
  const key = btoa(String.fromCharCode(...raw)).split("+").join("-").split("/").join("_").replace(/=+$/g, "");
  const master = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  const aes = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("aston-ciso-leads-v1"), info: new TextEncoder().encode("payload-encryption") },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = JSON.stringify({ name: "CISO Example", email: "security@example.com", company: "Example Corp" });
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("aston-ciso-lead:v1") },
    aes,
    new TextEncoder().encode(payload),
  );
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).split("+").join("-").split("/").join("_").replace(/=+$/g, "");
  const admin = { actor: "admin", method: "access", tenant: "aston", roles: ["admin"], clearance: "secret" };
  let limitBound = 0;
  const env = {
    LEADS_ENCRYPTION_KEY: key,
    DB: {
      prepare: (sql: string) => {
        assert.match(sql, /ORDER BY created_at DESC LIMIT \\? OFFSET \\?/);
        return {
          bind: (...args: unknown[]) => {
            limitBound = Number(args[1]);
            return { all: async () => ({ results: [{
              id: "lead-1", payload_ciphertext: encode(new Uint8Array(encrypted)),
              payload_iv: encode(iv), created_at: 100, expires_at: 9999999999999,
            }] }) };
          },
        };
      },
    },
  };
  const result = await handleEngineeringCisoLeads(
    "/v1/engineering/leads/ciso",
    new Request("https://api.aston.example/v1/engineering/leads/ciso?limit=500"),
    env as any,
    admin as any,
  );
  assert.equal(result?.status, 200);
  const body = await result!.json() as any;
  assert.equal(body.limit, 100);
  assert.equal(limitBound, 100);
  assert.equal(body.leads[0].email, "security@example.com");
});

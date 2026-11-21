import test from "node:test";
import assert from "node:assert/strict";
import { handleEngineering } from "../src/routes/engineering.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const admin = { actor: "admin", method: "access", tenant: "t1", roles: ["admin"], clearance: "confidential" } as const;
const viewer = { actor: "viewer", method: "access", tenant: "t1", roles: ["viewer"], clearance: "internal" } as const;

test("health endpoint rejects non-GET", async () => {
  const response = await handleEngineering("/v1/engineering/health", new Request("https://x/v1/engineering/health", { method: "POST" }), {} as any, admin as any, json);
  assert.equal(response?.status, 405);
});

test("health endpoint requires privileged role", async () => {
  const response = await handleEngineering("/v1/engineering/health", new Request("https://x/v1/engineering/health"), {} as any, viewer as any, json);
  assert.equal(response?.status, 403);
});

test("D1 probe returns positive result only after SELECT 1 succeeds", async () => {
  const env = { DB: { prepare: (sql: string) => ({ first: async () => ({ health: 1 }) }) } } as any;
  const response = await handleEngineering("/v1/engineering/health", new Request("https://x/v1/engineering/health"), env, admin as any, json);
  assert.equal(response?.status, 200);
  const body = await response?.json() as any;
  assert.equal(body.ok, true);
  assert.equal(body.mode, "read_only_probe");
  assert.equal(body.checks[0].id, "d1");
  assert.equal(body.checks[0].status, "ok");
  assert.match(body.checks[0].evidence, /SELECT 1/);
});

test("D1 failure returns degraded status without exposing exception details", async () => {
  const env = { DB: { prepare: () => ({ first: async () => { throw new Error("sensitive database error"); } }) } } as any;
  const response = await handleEngineering("/v1/engineering/health", new Request("https://x/v1/engineering/health"), env, admin as any, json);
  assert.equal(response?.status, 503);
  const body = await response?.json() as any;
  assert.equal(body.ok, false);
  assert.equal(body.checks[0].status, "error");
  assert.doesNotMatch(JSON.stringify(body), /sensitive database error/);
});

test("missing D1 is reported as unconfigured, not healthy", async () => {
  const response = await handleEngineering("/v1/engineering/health", new Request("https://x/v1/engineering/health"), {} as any, admin as any, json);
  assert.equal(response?.status, 503);
  const body = await response?.json() as any;
  assert.equal(body.ok, false);
  assert.equal(body.checks[0].status, "unconfigured");
});

test("public identity cannot gain engineering access by carrying an admin role", async () => {
  let probes = 0;
  const env = { DB: { prepare: () => { probes++; return { first: async () => ({ health: 1 }) }; } } } as any;
  const forgedRole = { ...admin, method: "public" } as any;
  const response = await handleEngineering("/v1/engineering/health", new Request("https://x/v1/engineering/health"), env, forgedRole, json);
  assert.equal(response?.status, 403);
  assert.equal(probes, 0, "unauthorized requests must not touch D1");
});

test("authenticated executor can run the read-only health probe", async () => {
  const executor = { actor: "operator-1", method: "access", tenant: "t1", roles: ["executor"], clearance: "confidential" } as any;
  const env = { DB: { prepare: () => ({ first: async () => ({ health: 1 }) }) } } as any;
  const response = await handleEngineering("/v1/engineering/health", new Request("https://x/v1/engineering/health"), env, executor, json);
  assert.equal(response?.status, 200);
  const body = await response?.json() as any;
  assert.equal(body.checks[0].status, "ok");
});

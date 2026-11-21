import test from "node:test";
import assert from "node:assert/strict";
import { handleEngineering } from "../src/routes/engineering.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const viewer = { actor: "viewer", method: "access", tenant: "t1", roles: ["viewer"], clearance: "internal" } as const;
const admin = { actor: "admin", method: "access", tenant: "t1", roles: ["admin"], clearance: "confidential" } as const;

test("does not handle unrelated paths", async () => {
  assert.equal(await handleEngineering("/health", new Request("https://x/health"), {} as any, {} as any, viewer as any, json), null);
});

test("rejects non-GET requests", async () => {
  const response = await handleEngineering("/v1/engineering/overview", new Request("https://x/v1/engineering/overview", { method: "POST" }), {} as any, {} as any, admin as any, json);
  assert.equal(response?.status, 405);
});

test("requires privileged engineering role", async () => {
  const response = await handleEngineering("/v1/engineering/overview", new Request("https://x/v1/engineering/overview"), {} as any, {} as any, viewer as any, json);
  assert.equal(response?.status, 403);
});

test("reports bindings as configuration only and avoids health claims", async () => {
  const env = { AI: {}, DB: {}, SESSION: {}, GRAPH: {}, SAFETY: {} } as any;
  const response = await handleEngineering("/v1/engineering/overview", new Request("https://x/v1/engineering/overview"), env, admin as any, json);
  assert.equal(response?.status, 200);
  const body = await response?.json() as any;
  assert.equal(body.mode, "configuration_snapshot");
  assert.match(body.warning, /not proof of runtime health/i);
  assert.equal(body.summary.configured, 4);
  assert.equal(body.resources.find((r: any) => r.id === "d1").configured, true);
  assert.equal(body.resources.find((r: any) => r.id === "vectorize").configured, false);
});

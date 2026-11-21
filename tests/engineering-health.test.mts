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
  const env = { DB: { prepare: (_sql: string) => ({ first: async () => ({ health: 1 }) }) } } as any;
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

test("D1 schema inventory reports table count and migration tracking separately", async () => {
  const env = { DB: { prepare: (sql: string) => ({
    first: async () => sql.includes("sqlite_master")
      ? ({ user_table_count: 21, migration_tracking_table: 0 })
      : ({ health: 1 }),
  }) } } as any;
  const response = await handleEngineering("/v1/engineering/health", new Request("https://x/v1/engineering/health"), env, admin as any, json);
  const body = await response?.json() as any;
  assert.equal(response?.status, 200);
  assert.equal(body.schema.status, "ok");
  assert.equal(body.schema.user_table_count, 21);
  assert.equal(body.schema.migration_tracking_table, false);
  assert.match(body.schema.evidence, /not found/);
});

test("schema inventory failure is diagnostic and does not erase successful D1 connectivity", async () => {
  const env = { DB: { prepare: (sql: string) => ({
    first: async () => {
      if (sql.includes("sqlite_master")) throw new Error("schema details");
      return { health: 1 };
    },
  }) } } as any;
  const response = await handleEngineering("/v1/engineering/health", new Request("https://x/v1/engineering/health"), env, admin as any, json);
  const body = await response?.json() as any;
  assert.equal(response?.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.schema.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(body), /schema details/);
});

test("incident feed requires privileged identity and never probes for public callers", async () => {
  let probes = 0;
  const env = { DB: { prepare: () => { probes++; return { first: async () => ({ health: 1 }) }; } } } as any;
  const response = await handleEngineering("/v1/engineering/incidents", new Request("https://x/v1/engineering/incidents"), env, viewer as any, json);
  assert.equal(response?.status, 403);
  assert.equal(probes, 0);
});

test("incident feed derives a low severity migration-history observation without claiming history", async () => {
  const env = { DB: { prepare: (sql: string) => ({ first: async () => sql.includes("sqlite_master")
    ? ({ user_table_count: 21, migration_tracking_table: 0 })
    : ({ health: 1 }) }) } } as any;
  const response = await handleEngineering("/v1/engineering/incidents", new Request("https://x/v1/engineering/incidents"), env, admin as any, json);
  const body = await response?.json() as any;
  assert.equal(response?.status, 200);
  assert.equal(body.mode, "derived_read_only_snapshot");
  assert.equal(body.persistence, "not_persisted");
  assert.equal(body.history_available, false);
  assert.equal(body.write_operations, 0);
  assert.equal(body.summary.low, 1);
  assert.equal(body.incidents[0].type, "migration_history_unverified");
  assert.match(body.incidents[0].evidence, /does not prove/);
});

test("incident feed classifies D1 connectivity failure as critical and redacts exception", async () => {
  const env = { DB: { prepare: () => ({ first: async () => { throw new Error("secret db internals"); } }) } } as any;
  const response = await handleEngineering("/v1/engineering/incidents", new Request("https://x/v1/engineering/incidents"), env, admin as any, json);
  const body = await response?.json() as any;
  assert.equal(response?.status, 200);
  assert.equal(body.summary.critical, 1);
  assert.equal(body.incidents[0].severity, "critical");
  assert.doesNotMatch(JSON.stringify(body), /secret db internals/);
});

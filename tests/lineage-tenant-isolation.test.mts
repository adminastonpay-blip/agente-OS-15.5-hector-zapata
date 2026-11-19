import test from "node:test";
import assert from "node:assert/strict";
import { emitLineage, getLineageTree } from "../src/lineage.ts";
import { handleV21 } from "../src/routes/v21.ts";

const rows = [
  { id: "lin-a", tenant: "tenant-alpha", object_id: "shared-object", transformation: "alpha", ts: 20 },
  { id: "lin-b", tenant: "tenant-beta", object_id: "shared-object", transformation: "beta", ts: 30 },
];

function fakeDb() {
  const writes: unknown[][] = [];
  const queries: { sql: string; args: unknown[] }[] = [];
  return {
    writes,
    queries,
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { args = values; return statement; },
        async run() { writes.push(args); return { success: true }; },
        async all() {
          queries.push({ sql, args });
          if (!sql.includes("FROM lineage_events")) return { results: [] };
          const [tenant, objectId, limit] = args as [string, string, number];
          return { results: rows.filter((row) => row.tenant === tenant && row.object_id === objectId).slice(0, limit) };
        },
      };
      return statement;
    },
  };
}

const identity = (tenant: string) => ({
  actor: `actor-${tenant}`, method: "access" as const, tenant,
  roles: ["executor"], clearance: "confidential" as const,
});

test("LIN-01 / emitted lineage records persist the authenticated tenant", async () => {
  const DB = fakeDb();
  await emitLineage({ DB } as any, {
    tenant: "tenant-alpha", object_id: "shared-object",
    transformation: "rag_ingest", pipeline_version: "21.0", actor: "actor-alpha",
  });
  assert.equal(DB.writes.length, 1);
  assert.equal(DB.writes[0][1], "tenant-alpha");
});

test("LIN-02 / lineage reads are scoped by tenant and object ID", async () => {
  const DB = fakeDb();
  const alpha = await getLineageTree({ DB } as any, "tenant-alpha", "shared-object");
  const beta = await getLineageTree({ DB } as any, "tenant-beta", "shared-object");
  assert.deepEqual(alpha.map((row: any) => row.id), ["lin-a"]);
  assert.deepEqual(beta.map((row: any) => row.id), ["lin-b"]);
  assert.match(DB.queries[0].sql, /WHERE tenant = \? AND object_id = \?/);
  assert.deepEqual(DB.queries[0].args.slice(0, 2), ["tenant-alpha", "shared-object"]);
});

test("LIN-03 / lineage API cannot return another tenant's colliding object ID", async () => {
  const DB = fakeDb();
  const call = async (tenant: string) => {
    const response = await handleV21(
      "/v1/lineage",
      new Request("https://aston.test/v1/lineage?object_id=shared-object"),
      { DB } as any,
      identity(tenant),
      (body, status = 200) => Response.json(body, { status }),
    );
    assert.ok(response);
    return response.json() as Promise<any>;
  };
  const alpha = await call("tenant-alpha");
  const beta = await call("tenant-beta");
  assert.deepEqual(alpha.events.map((row: any) => row.id), ["lin-a"]);
  assert.deepEqual(beta.events.map((row: any) => row.id), ["lin-b"]);
});

test("LIN-04 / missing tenant fails closed for lineage reads and writes", async () => {
  const DB = fakeDb();
  assert.deepEqual(await getLineageTree({ DB } as any, "", "shared-object"), []);
  await assert.rejects(
    () => emitLineage({ DB } as any, {
      tenant: "", object_id: "shared-object", transformation: "test", pipeline_version: "test",
    }),
    /lineage tenant required/,
  );
  assert.equal(DB.writes.length, 0);
});

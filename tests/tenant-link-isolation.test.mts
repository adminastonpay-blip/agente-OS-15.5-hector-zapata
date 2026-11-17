import test from "node:test";
import assert from "node:assert/strict";
import { createLink, cascadeImpact } from "../src/ontology.ts";
import { handleV21 } from "../src/routes/v21.ts";

function fakeDb() {
  const insertedLinks: unknown[][] = [];
  const edges = [
    { tenant: "tenant-alpha", from_id: "root-shared", to_id: "alpha-child", type: "owns" },
    { tenant: "tenant-beta", from_id: "root-shared", to_id: "beta-child", type: "owns" },
  ];
  return {
    insertedLinks,
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { args = values; return statement; },
        async first() {
          if (sql.includes("FROM objects")) {
            const [tenant, id] = args;
            return (tenant === "tenant-alpha" && ["alpha-root", "alpha-child"].includes(String(id)))
              ? { id }
              : (tenant === "tenant-beta" && ["beta-root", "beta-child"].includes(String(id)))
                ? { id }
                : null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM links")) {
            const [tenant, fromId] = args;
            return { results: edges.filter((edge) => edge.tenant === tenant && edge.from_id === fromId) };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO links")) insertedLinks.push(args);
          return { success: true };
        },
      };
      return statement;
    },
  };
}

const identity = (tenant: string) => ({
  actor: `actor-${tenant}`,
  method: "access" as const,
  tenant,
  roles: ["executor"],
  clearance: "confidential" as const,
});

test("TEN-01 / link creation rejects a nested endpoint owned by another tenant", async () => {
  const DB = fakeDb();
  await assert.rejects(
    () => createLink({ DB } as any, identity("tenant-alpha"), {
      from_id: "alpha-root",
      to_id: "beta-child",
      type: "owns",
    }),
    /link endpoints must belong to caller tenant/,
  );
  assert.equal(DB.insertedLinks.length, 0);
});

test("TEN-01 / legitimate same-tenant link remains creatable", async () => {
  const DB = fakeDb();
  await createLink({ DB } as any, identity("tenant-alpha"), {
    from_id: "alpha-root",
    to_id: "alpha-child",
    type: "owns",
  });
  assert.equal(DB.insertedLinks.length, 1);
  assert.equal(DB.insertedLinks[0][1], "tenant-alpha");
});

test("TEN-03 / impact route scopes colliding external root IDs by tenant", async () => {
  const DB = fakeDb();
  const call = async (tenant: string) => {
    const response = await handleV21(
      "/v1/ontology/impact",
      new Request("https://aston.test/v1/ontology/impact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root_id: "root-shared", at: 10 }),
      }),
      { DB } as any,
      identity(tenant),
      (body, status = 200) => Response.json(body, { status }),
    );
    assert.ok(response);
    return response.json() as Promise<any>;
  };
  const alpha = await call("tenant-alpha");
  const beta = await call("tenant-beta");
  assert.deepEqual(alpha.impact.map((item: any) => item.to_id), ["alpha-child"]);
  assert.deepEqual(beta.impact.map((item: any) => item.to_id), ["beta-child"]);
});

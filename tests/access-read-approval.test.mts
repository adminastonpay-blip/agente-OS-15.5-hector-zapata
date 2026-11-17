import test from "node:test";
import assert from "node:assert/strict";
import { handleAccess } from "../src/access/access.ts";

const identity = {
  actor: "reader-01",
  method: "access" as const,
  tenant: "tenant-alpha",
  roles: ["viewer"],
  clearance: "internal" as const,
};

function database(effect: "allow" | "require_approval") {
  const policy = {
    id: "policy-read-01",
    tenant: identity.tenant,
    name: "read policy",
    role: "*",
    object_type: "case_record",
    action: "read",
    purpose: effect === "allow" ? "operational" : "sensitive",
    clearance: "*",
    effect,
    row_filter: null,
    restricted_fields: [],
    priority: 100,
  };
  const record = {
    id: "case-001",
    type_id: "case_record",
    properties: JSON.stringify({ title: "fixture record", secret: "must-not-leak" }),
    version: 1,
    created_at: 1,
  };
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { args = values; return statement; },
        async all() {
          if (sql.includes("FROM access_policies")) return { results: [policy] };
          if (sql.includes("FROM objects")) return { results: [record] };
          return { results: [] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return statement;
    },
  };
}

async function readRoute(env: any, purpose: string) {
  const request = new Request(
    `https://aston.test/v1/ontology/objects/secure?type_id=case_record&purpose=${purpose}`,
    { method: "GET" },
  );
  const response = await handleAccess(
    "/v1/ontology/objects/secure",
    request,
    env,
    identity,
    (body, status = 200) => Response.json(body, { status }),
  );
  assert.ok(response);
  return response.json() as Promise<any>;
}

test("AUTHZ-REQAPP-001 / sensitive read with require_approval never releases records", async () => {
  const result = await readRoute({ DB: database("require_approval") }, "sensitive");
  assert.equal(result.allowed, false);
  assert.equal(result.effect, "require_approval");
  assert.deepEqual(result.items, []);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|fixture record/);
});

test("AUTHZ-REQAPP-001 / operational read with explicit allow remains available", async () => {
  const result = await readRoute({ DB: database("allow") }, "operational");
  assert.equal(result.allowed, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, "case-001");
  assert.equal(result.items[0].properties.title, "fixture record");
});

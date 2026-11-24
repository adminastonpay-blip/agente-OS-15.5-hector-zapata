import test from "node:test";
import assert from "node:assert/strict";
import { handleDefense } from "../src/routes/defense.ts";

test("DEFENSE-APPROVAL-ACTOR-001 / caller cannot forge the human approver identity", async () => {
  let forwarded: any;
  let namespaceKey = "";
  const identity = {
    actor: "verified-operator-17",
    method: "access",
    tenant: "tenant-alpha",
    roles: ["approver"],
    clearance: "internal",
  } as any;
  const env = {
    SAFETY: {
      idFromName(name: string) {
        namespaceKey = name;
        return name;
      },
      get(_id: string) {
        return {
          async fetch(_url: string, init: RequestInit) {
            forwarded = JSON.parse(String(init.body));
            return Response.json({ status: "approved", approval_id: forwarded.approval_id });
          },
        };
      },
    },
  } as any;
  const response = await handleDefense(
    "/v1/defense/approve",
    new Request("https://aston.test/v1/defense/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        approval_id: "apr_fixture_001",
        approved: true,
        operator: "attacker-controlled-name",
      }),
    }),
    env,
    identity,
    (data, status = 200) => Response.json(data, { status }),
  );

  assert.equal(response?.status, 200);
  assert.equal(namespaceKey, "tenant-alpha::safety");
  assert.equal(forwarded.approval_id, "apr_fixture_001");
  assert.equal(forwarded.approved, true);
  assert.equal(forwarded.operator, "verified-operator-17");
  assert.notEqual(forwarded.operator, "attacker-controlled-name");
  assert.equal(forwarded.identity.actor, "verified-operator-17");
  assert.ok(forwarded.identity.roles.includes("approver"));
});

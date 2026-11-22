import test from "node:test";
import assert from "node:assert/strict";
import { authenticate } from "../src/auth.ts";
import { authorizeApiRequest } from "../src/security/mvsp-access.ts";

test("shared API key authenticates only as an unassigned machine identity", async () => {
  const identity = await authenticate(
    new Request("https://aston.test/private", {
      headers: { Authorization: "Bearer shared-secret" },
    }),
    { API_KEY: "shared-secret" } as any,
  );
  assert.ok(identity);
  assert.equal(identity.method, "apikey");
  assert.equal(identity.tenant.startsWith("unassigned-machine-"), true);
  assert.deepEqual(identity.roles, ["service"]);
  assert.equal(identity.plan, undefined);
  assert.notEqual(identity.clearance, "secret");
  assert.deepEqual(
    authorizeApiRequest(new Request("https://aston.test/private"), "/private", identity),
    { allowed: false, status: 403, error: "tenant_assignment_required" },
  );
  assert.deepEqual(
    authorizeApiRequest(new Request("https://aston.test/private", { method: "POST" }), "/private", identity),
    { allowed: false, status: 403, error: "tenant_assignment_required" },
  );
});

test("sensor credential has no operator privilege or tenant assignment", async () => {
  const identity = await authenticate(
    new Request("https://aston.test/private", {
      headers: { "X-Sensor-Key": "shared-secret" },
    }),
    { API_KEY: "shared-secret" } as any,
  );
  assert.ok(identity);
  assert.equal(identity.method, "sensor");
  assert.equal(identity.tenant, "unassigned-sensor");
  assert.deepEqual(identity.roles, ["sensor"]);
  assert.equal(identity.plan, undefined);
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleProvenance } from "../src/routes/provenance.ts";
import { buildConstitution } from "../src/provenance/constitution.ts";

const identity = { tenant: "tenant-a", actor: "test-actor", roles: [] } as any;
const env = {} as any;
const json = (data: unknown, status = 200) => Response.json(data, { status });

describe("constitution check route — advisory trust boundary", () => {
  it("labels caller-supplied evaluation as non-authoritative", async () => {
    const constitution = buildConstitution({
      agent_id: "agent-a",
      objective: "route advisory test",
    });
    const request = new Request("https://unit.test/v1/constitution/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        constitution,
        calls: 1,
        cost_usdc: 0,
        writes: 0,
        wall_ms: 1,
        risk_score: 1,
        tool: "search",
      }),
    });

    const response = await handleProvenance(
      "/v1/constitution/check",
      request,
      env,
      identity,
      json,
    );
    assert.ok(response);
    const payload = await response.json() as any;

    assert.equal(payload.ok, true);
    assert.equal(payload.authority, "advisory");
    assert.equal(payload.authoritative, false);
    assert.equal(payload.input_source, "caller_supplied");
    assert.match(payload.warning, /does not authenticate the policy issuer/i);
    assert.match(payload.warning, /does not authorize execution/i);
  });

  it("rejects a request with no constitution object", async () => {
    const request = new Request("https://unit.test/v1/constitution/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "search" }),
    });

    const response = await handleProvenance(
      "/v1/constitution/check",
      request,
      env,
      identity,
      json,
    );
    assert.ok(response);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "constitution required",
    });
  });
});

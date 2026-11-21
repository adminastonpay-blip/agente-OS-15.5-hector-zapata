import test from "node:test";
import assert from "node:assert/strict";
import type { Env, Identity } from "../src/types";
import { appendTenantAuditEvent, handleAuditLedger } from "../src/audit/ledger";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const admin: Identity = {
  actor: "operator-1", method: "access", tenant: "tenant-a",
  roles: ["admin"], clearance: "confidential",
};
const viewer: Identity = {
  actor: "viewer-1", method: "access", tenant: "tenant-a",
  roles: ["viewer"], clearance: "internal",
};

function mockEnv(response = Response.json({
  ok: true,
  events: [{ id: 4, event_id: "audit-4", actor: "operator-1", event_type: "agent.plan.created", ts: 1234,
    previous_hash: "a".repeat(64), event_hash: "b".repeat(64), payload_fields: ["plan_id"] }],
  next_before_id: null,
  page_chain_links_valid: true,
  integrity_scope: "links_between_returned_events_only",
})) {
  let idName = "";
  let targetUrl = "";
  let method = "";
  const env = {
    SAFETY: {
      idFromName: (name: string) => { idName = name; return {}; },
      get: (_id: unknown) => ({
        fetch: async (url: string, init?: RequestInit) => {
          targetUrl = url;
          method = init?.method || "GET";
          return response;
        },
      }),
    },
  } as unknown as Env;
  return { env, getCapture: () => ({ idName, targetUrl, method }) };
}

test("audit feed is tenant-scoped using verified identity, not caller query", async () => {
  const { env, getCapture } = mockEnv();
  const request = new Request("https://aston.test/v1/audit/events?tenant=tenant-b&limit=10");
  const response = await handleAuditLedger("/v1/audit/events", request, env, admin, json);
  const body = await response?.json() as any;
  const capture = getCapture();
  assert.equal(response?.status, 200);
  assert.equal(capture.idName, "audit:tenant-a");
  assert.equal(new URL(capture.targetUrl).searchParams.get("tenant"), "tenant-a");
  assert.equal(new URL(capture.targetUrl).searchParams.get("limit"), "10");
  assert.equal(capture.method, "GET");
  assert.equal(body.page_chain_links_valid, true);
});

test("audit feed denies public and viewer identities", async () => {
  const { env } = mockEnv();
  const publicId = { ...admin, method: "public" } as Identity;
  const deniedPublic = await handleAuditLedger("/v1/audit/events", new Request("https://x/v1/audit/events"), env, publicId, json);
  const deniedViewer = await handleAuditLedger("/v1/audit/events", new Request("https://x/v1/audit/events"), env, viewer, json);
  assert.equal(deniedPublic?.status, 403);
  assert.equal(deniedViewer?.status, 403);
});

test("audit feed validates pagination bounds", async () => {
  const { env } = mockEnv();
  const response = await handleAuditLedger("/v1/audit/events", new Request("https://x/v1/audit/events?limit=1000"), env, admin, json);
  assert.equal(response?.status, 400);
});

test("audit feed fails closed when SafetyInterlock is unavailable", async () => {
  const response = await handleAuditLedger("/v1/audit/events", new Request("https://x/v1/audit/events"), {} as Env, admin, json);
  assert.equal(response?.status, 503);
});

test("legacy global D1 audit endpoint is retired without writing", async () => {
  let writes = 0;
  const env = { DB: { prepare: () => { writes++; return { run: async () => ({}) }; } } } as unknown as Env;
  const response = await handleAuditLedger("/v1/audit", new Request("https://x/v1/audit", { method: "POST" }), env, admin, json);
  assert.equal(response?.status, 410);
  assert.equal(writes, 0);
});

test("audit append uses trusted identity and the tenant hash-chain Durable Object", async () => {
  let idName = "";
  let sent: any;
  const env = {
    SAFETY: {
      idFromName: (name: string) => { idName = name; return {}; },
      get: () => ({ fetch: async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ ok: true, recorded: true }), { status: 200 });
      } }),
    },
  } as unknown as Env;
  const persisted = await appendTenantAuditEvent(env, admin, "decision.inferred", { model: "test-model", rag: false, answer_length: 12 });
  assert.equal(persisted, true);
  assert.equal(idName, "audit:tenant-a");
  assert.equal(sent.tenant, "tenant-a");
  assert.equal(sent.actor, "operator-1");
  assert.equal(sent.event_type, "decision.inferred");
  assert.equal("actor" in sent.payload, false);
});

test("optional missing ledger reports not persisted; required ledger fails closed", async () => {
  const optional = await appendTenantAuditEvent({} as Env, admin, "decision.inferred", { rag: false });
  assert.equal(optional, false);
  await assert.rejects(
    appendTenantAuditEvent({ AUDIT_ANCHOR_REQUIRED: "true" } as Env, admin, "decision.inferred", { rag: false }),
    /audit_safety_binding_missing/
  );
});

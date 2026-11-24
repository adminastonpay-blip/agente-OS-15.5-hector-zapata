import test from "node:test";
import assert from "node:assert/strict";
import { ControlGate } from "../src/core/control-gate.ts";
import { ModelRunner } from "../src/core/model-runner.ts";
import type { MissionTokenPayload } from "../src/core/mission-token.ts";

const payload: MissionTokenPayload = {
  iss: "aston-os-gateway",
  aud: "recovery-workflow",
  sub: "verified-agent-42",
  tenantId: "tenant-42",
  action: "recovery_diagnosis",
  jti: "9f1c4d20-6b8a-4a31-9d20-0a2f5e6c7b81",
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 600,
  missionId: "mission-2026-0001",
  missionHash: "a".repeat(64),
};
const content = JSON.stringify({ mission: payload.missionId, origin: "https://api.example.test" });

function makeEnv(options: { safety?: string; rate?: number } = {}) {
  const calls = { evaluate: 0, rate: 0, ai: 0, rateAction: "" };
  const namespace = {
    idFromName: (name: string) => name,
    get: (_id: string) => ({
      fetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith("/evaluate")) {
          calls.evaluate++;
          const body = JSON.parse(String(init?.body));
          assert.equal(body.identity.tenant, payload.tenantId);
          assert.equal(body.identity.actor, payload.sub);
          assert.equal(body.action.tool, "recovery_diagnosis");
          return Response.json({ status: options.safety ?? "allowed" });
        }
        if (url.endsWith("/rate-limit/check")) {
          calls.rate++;
          calls.rateAction = _id;
          const policy = JSON.parse(String(init?.body));
          assert.equal(policy.limit, 5);
          assert.equal(policy.window_ms, 60_000);
          return Response.json({ allowed: options.rate !== 429 }, { status: options.rate ?? 200 });
        }
        return new Response("not found", { status: 404 });
      },
    }),
  };
  const env = {
    AI: { run: async () => { calls.ai++; return { response: '{"text":"diagnosis","confidence":0.9,"action":"none"}' }; } },
    SAFETY: namespace,
    CHAT_MODEL: "@cf/meta/llama-3.1-8b-instruct",
    INTERNAL_ASSERTION_SECRET: "unit-test-secret-1234567890",
    INTERNAL_ASSERTION_KEY_ID: "test-recovery-gate",
  } as any;
  return { env, calls };
}

test("1. rechaza token con acción distinta (cross-permission)", async () => {
  const { env, calls } = makeEnv();
  const result = await new ControlGate(env).authorizeAction({ ...payload, action: "chat" } as any, content);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_recovery_action");
  assert.equal(calls.evaluate, 0);
  assert.equal(calls.ai, 0);
});

test("2. rechaza sujeto/tenant ausente sin evaluar ni inferir", async () => {
  const { env, calls } = makeEnv();
  const result = await new ControlGate(env).authorizeAction({ ...payload, sub: "", tenantId: "" }, content);
  assert.equal(result.ok, false);
  assert.equal(calls.evaluate, 0);
  assert.equal(calls.ai, 0);
});

test("3. SafetyInterlock denegado bloquea inferencia", async () => {
  const { env, calls } = makeEnv({ safety: "denied" });
  const result = await new ControlGate(env).authorizeAction(payload, content);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 403);
  assert.equal(calls.rate, 0);
  assert.equal(calls.ai, 0);
});

test("4. rate limit Recovery bloquea inferencia", async () => {
  const { env, calls } = makeEnv({ rate: 429 });
  const result = await new ControlGate(env).authorizeAction(payload, content);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 429);
  assert.equal(calls.ai, 0);
});

test("5. permiso Recovery autoriza una sola inferencia con payload exacto", async () => {
  const { env, calls } = makeEnv();
  const gate = new ControlGate(env);
  const result = await gate.authorizeAction(payload, content);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const runner = new ModelRunner(env);
  const output = await runner.runInference(result.permit, "recovery_diagnosis", content);
  assert.match(output.response, /diagnosis/);
  await assert.rejects(
    runner.runInference(result.permit, "recovery_diagnosis", content + " altered"),
    /invalid_or_replayed_inference_permit/
  );
  await assert.rejects(
    runner.runInference(result.permit, "recovery_diagnosis", content),
    /invalid_or_replayed_inference_permit/
  );
  assert.equal(calls.ai, 1);
});

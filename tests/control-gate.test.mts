import test from "node:test";
import assert from "node:assert/strict";
import { ControlGate } from "../src/core/control-gate.ts";
import { ModelRunner } from "../src/core/model-runner.ts";

const identity = {
  actor: "red-team-user",
  method: "access" as const,
  tenant: "tenant-red-team",
  roles: ["operator"],
  clearance: "internal" as const,
};

const messages = [
  { role: "system" as const, content: "ASTON test" },
  { role: "user" as const, content: "hola" },
];

function makeEnv(options: {
  safetyStatus?: string;
  rateStatus?: number;
  rateAllowed?: boolean;
  safetyHttpStatus?: number;
} = {}) {
  const calls = { evaluate: 0, rate: 0, ai: 0 };
  const ai = {
    run: async () => {
      calls.ai++;
      return { response: "respuesta autorizada" };
    },
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (_id: string) => ({
      fetch: async (url: string) => {
        if (url.endsWith("/evaluate")) {
          calls.evaluate++;
          return Response.json(
            { status: options.safetyStatus ?? "allowed", policy: { decision: options.safetyStatus ?? "allowed" } },
            { status: options.safetyHttpStatus ?? 200 },
          );
        }
        if (url.endsWith("/rate-limit/check")) {
          calls.rate++;
          if (options.rateStatus === 429) {
            return Response.json({ allowed: false }, { status: 429 });
          }
          return Response.json(
            { allowed: options.rateAllowed ?? true },
            { status: options.rateStatus ?? 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    }),
  };
  return {
    calls,
    env: {
      AI: ai,
      SAFETY: namespace,
      CHAT_MODEL: "@cf/meta/llama-3.1-8b-instruct",
      // Test-only signing material: production ControlGate must fail closed without these bindings.
      INTERNAL_ASSERTION_SECRET: "unit-test-secret-1234567890",
      INTERNAL_ASSERTION_KEY_ID: "test-control-gate",
    } as any,
  };
}

test("1. deniega identidad ausente, pública o incompleta", async () => {
  const { env, calls } = makeEnv();
  const result = await new ControlGate(env).authorizeChat(
    { ...identity, method: "public" } as any,
    messages,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 403);
  assert.equal(calls.evaluate, 0);
  assert.equal(calls.ai, 0);
});

test("2. deniega en Fail-Closed si SafetyInterlock no está disponible", async () => {
  const { env, calls } = makeEnv();
  env.SAFETY = undefined;
  const result = await new ControlGate(env).authorizeChat(identity, messages);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 503);
  assert.equal(calls.ai, 0);
});

test("3. deniega una decisión de política no permitida", async () => {
  const { env, calls } = makeEnv({ safetyStatus: "denied" });
  const result = await new ControlGate(env).authorizeChat(identity, messages);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 403);
  assert.equal(calls.rate, 0);
  assert.equal(calls.ai, 0);
});

test("4. deniega cuando el rate limiter devuelve 429", async () => {
  const { env, calls } = makeEnv({ rateStatus: 429 });
  const result = await new ControlGate(env).authorizeChat(identity, messages);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 429);
  assert.equal(calls.evaluate, 1);
  assert.equal(calls.ai, 0);
});

test("5. rechaza payload alterado después de emitir el permiso (TOCTOU)", async () => {
  const { env, calls } = makeEnv();
  const result = await new ControlGate(env).authorizeChat(identity, messages);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const altered = [...messages.slice(0, 1), { role: "user" as const, content: "payload alterado" }];
  await assert.rejects(
    new ModelRunner(env).runChat(result.permit, altered),
    /invalid_or_replayed_inference_permit/,
  );
  assert.equal(calls.ai, 0);
});

test("6. consume el permiso una sola vez y bloquea replay", async () => {
  const { env, calls } = makeEnv();
  const result = await new ControlGate(env).authorizeChat(identity, messages);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const runner = new ModelRunner(env);
  await runner.runChat(result.permit, messages);
  await assert.rejects(
    runner.runChat(result.permit, messages),
    /invalid_or_replayed_inference_permit/,
  );
  assert.equal(calls.ai, 1);
});

test("7. permite exactamente una inferencia cuando política y rate limit autorizan", async () => {
  const { env, calls } = makeEnv();
  const result = await new ControlGate(env).authorizeChat(identity, messages);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = await new ModelRunner(env).runChat(result.permit, messages);
  assert.equal(output.response, "respuesta autorizada");
  assert.equal(output.model, "@cf/meta/llama-3.1-8b-instruct");
  assert.deepEqual(calls, { evaluate: 1, rate: 1, ai: 1 });
});


test("8. embeddings permit is scoped, bound to payload, and single-use", async () => {
  const { env, calls } = makeEnv();
  const payload = { text: ["tenant data"] };
  const result = await new ControlGate(env).authorizeInference(
    identity, "embeddings", payload, "@cf/baai/bge-m3",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const runner = new ModelRunner(env);
  await runner.execute(result.permit, "embeddings", "@cf/baai/bge-m3", payload);
  await assert.rejects(
    runner.execute(result.permit, "embeddings", "@cf/baai/bge-m3", payload),
    /invalid_or_replayed_inference_permit/,
  );
  assert.equal(calls.ai, 1);
});

test("9. TTS permit cannot authorize embeddings or a modified payload", async () => {
  const { env, calls } = makeEnv();
  const payload = { text: "hola" };
  const result = await new ControlGate(env).authorizeInference(
    identity, "tts", payload, "@cf/deepgram/aura-2-es",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const runner = new ModelRunner(env);
  await assert.rejects(
    runner.execute(result.permit, "embeddings", "@cf/deepgram/aura-2-es", payload),
    /invalid_or_replayed_inference_permit/,
  );
  await assert.rejects(
    runner.execute(result.permit, "tts", "@cf/deepgram/aura-2-es", { text: "texto alterado" }),
    /invalid_or_replayed_inference_permit/,
  );
  assert.equal(calls.ai, 0);
});

test("10. embeddings and TTS fail closed without a verified tenant identity", async () => {
  const { env, calls } = makeEnv();
  const result = await new ControlGate(env).authorizeInference(
    { ...identity, method: "public", tenant: "tenant-red-team" },
    "embeddings",
    { text: ["public data"] },
    "@cf/baai/bge-m3",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 403);
  assert.equal(calls.ai, 0);
  assert.equal(calls.evaluate, 0);
});


test("11. chat fallback model is explicitly bound to its one-use permit", async () => {
  const { env, calls } = makeEnv();
  const fallbackModel = "@cf/meta/llama-3.1-8b-instruct-fast";
  const result = await new ControlGate(env).authorizeChat(identity, messages, fallbackModel);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = await new ModelRunner(env).runChat(
    result.permit, messages, { maxTokens: 128 }, fallbackModel, false,
  );
  assert.equal(output.model, fallbackModel);
  assert.equal(calls.ai, 1);
});

test("12. direct retry requires a newly authorized permit", async () => {
  const { env, calls } = makeEnv();
  const gate = new ControlGate(env);
  const first = await gate.authorizeInference(identity, "embeddings", { text: ["x"] }, "@cf/baai/bge-m3");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const runner = new ModelRunner(env);
  await runner.execute(first.permit, "embeddings", "@cf/baai/bge-m3", { text: ["x"] }, true);
  const second = await gate.authorizeInference(identity, "embeddings", { text: ["x"] }, "@cf/baai/bge-m3");
  assert.equal(second.ok, true);
  if (!second.ok) return;
  await runner.execute(second.permit, "embeddings", "@cf/baai/bge-m3", { text: ["x"] }, false);
  assert.equal(calls.ai, 2);
});

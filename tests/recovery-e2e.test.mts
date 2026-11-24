import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { TokenIssuer } from "../src/core/token-issuer.ts";
import { KmsSignatureProvider } from "../src/core/signature-adapter.ts";
import { MissionTokenVerifier } from "../src/core/mission-token.ts";
import { ControlGate } from "../src/core/control-gate.ts";
import { ModelRunner } from "../src/core/model-runner.ts";

const identity = {
  actor: "recovery-admin-e2e",
  method: "access" as const,
  tenant: "tenant-e2e",
  roles: ["RECOVERY_ADMIN"],
  clearance: "secret" as const,
};
const mission = {
  missionId: "mission-e2e-2026",
  tenantId: "tenant-e2e",
  origin: "https://recovery.example.test/health",
  poolId: "pool-e2e",
  errorCode: 503,
  severity: "high" as const,
};

function makeEnv() {
  const consumed = new Set<string>();
  const calls = { safety: 0, rate: 0, ai: 0 };
  const safetyNamespace = {
    idFromName: (name: string) => name,
    get: (_id: string) => ({
      fetch: async (url: string) => {
        if (url.endsWith("/evaluate")) {
          calls.safety++;
          return Response.json({ status: "allowed" });
        }
        if (url.endsWith("/rate-limit/check")) {
          calls.rate++;
          return Response.json({ allowed: true });
        }
        return new Response("not found", { status: 404 });
      },
    }),
  };
  const replayNamespace = {
    idFromName: (name: string) => name,
    get: (_id: string) => ({
      fetch: async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { jti?: string };
        if (!body.jti) return Response.json({ fresh: false }, { status: 400 });
        if (consumed.has(body.jti)) {
          return Response.json({ fresh: false }, { status: 409 });
        }
        consumed.add(body.jti);
        return Response.json({ fresh: true });
      },
    }),
  };
  const env = {
    AI: {
      run: async () => {
        calls.ai++;
        return { response: "diagnóstico simulado y autorizado" };
      },
    },
    SAFETY: safetyNamespace,
    REPLAY_GUARD: replayNamespace,
    CHAT_MODEL: "@cf/meta/llama-3.1-8b-instruct",
    INTERNAL_ASSERTION_SECRET: "unit-test-secret-1234567890",
    INTERNAL_ASSERTION_KEY_ID: "test-recovery-e2e",
  } as any;
  return { env, calls };
}

test("E2E Recovery: emisión → verificación → anti-replay → ControlGate → ModelRunner → payload mismatch", async () => {
  // Acto 1 — emisión con una implementación KMS simulada; la clave queda
  // encapsulada en el cliente de prueba y nunca forma parte de TokenIssuer.
  const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const kmsMock = {
    signEd25519: async (_keyId: string, data: Uint8Array) =>
      new Uint8Array(await webcrypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, data)),
  };
  const issuer = new TokenIssuer(
    new KmsSignatureProvider(kmsMock, "kms-test-ed25519-key"),
    {
      allowedOrigins: ["https://recovery.example.test"],
      createJti: () => "9f1c4d20-6b8a-4a31-9d20-0a2f5e6c7b81",
    },
  );
  const token = await issuer.issueMissionToken(identity, mission);
  assert.equal(typeof token, "string");

  // Acto 2 — verificar firma y claims con el verificador de producción.
  const rawPublicKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  const publicKeyB64Url = btoa(String.fromCharCode(...rawPublicKey))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const verifier = await MissionTokenVerifier.fromBase64UrlPublicKey(publicKeyB64Url);
  const claims = await verifier.verify(token);
  assert.equal(claims.action, "recovery_diagnosis");
  assert.equal(claims.tenantId, mission.tenantId);

  const { env, calls } = makeEnv();
  const gate = new ControlGate(env);

  // Acto 3 — primer consumo sí; segundo consumo del mismo jti no.
  const firstClaim = await gate.consumeMissionToken(claims);
  assert.deepEqual(firstClaim, { ok: true });
  const replayClaim = await gate.consumeMissionToken(claims);
  assert.deepEqual(replayClaim, {
    ok: false, status: 403, reason: "mission_token_replay",
  });

  // Acto 4 — ControlGate obtiene autorización de SafetyInterlock y emite permiso.
  const content = "Diagnosticar misión mission-e2e-2026; no ejecutar remediaciones.";
  const authorization = await gate.authorizeAction(claims, content);
  assert.equal(authorization.ok, true);
  if (!authorization.ok) return;

  // Acto 5 — payload alterado no consume ni valida el permiso; el payload
  // original puede ejecutarse una sola vez mediante el mismo permiso.
  const runner = new ModelRunner(env);
  await assert.rejects(
    runner.runInference(authorization.permit, "recovery_diagnosis", content + " alterado"),
    /invalid_or_replayed_inference_permit/,
  );
  const output = await runner.runInference(
    authorization.permit, "recovery_diagnosis", content,
  );
  assert.equal(output.response, "diagnóstico simulado y autorizado");
  assert.equal(calls.ai, 1);

  // Acto 6 — el permiso ya consumido no se puede reutilizar ni siquiera
  // con el payload original.
  await assert.rejects(
    runner.runInference(authorization.permit, "recovery_diagnosis", content),
    /invalid_or_replayed_inference_permit/,
  );
  assert.deepEqual(calls, { safety: 1, rate: 1, ai: 1 });
});

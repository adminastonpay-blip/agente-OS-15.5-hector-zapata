import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { MissionTokenVerifier, type MissionTokenPayload } from "../src/core/mission-token.ts";
import { ControlGate } from "../src/core/control-gate.ts";

const b64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};
const encode = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function fixture(overrides: Partial<MissionTokenPayload> = {}) {
  const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const rawPublic = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  const now = Math.floor(Date.now() / 1000);
  const payload: MissionTokenPayload = {
    iss: "aston-os-gateway",
    aud: "recovery-workflow",
    sub: "authenticated-agent-42",
    tenantId: "tenant-42",
    action: "recovery_diagnosis",
    jti: "9f1c4d20-6b8a-4a31-9d20-0a2f5e6c7b81",
    iat: now,
    exp: now + 600,
    missionId: "mission-2026-0001",
    ...overrides,
  };
  const header = encode({ alg: "EdDSA", typ: "JWT" });
  const body = encode(payload);
  const input = header + "." + body;
  const signature = new Uint8Array(await webcrypto.subtle.sign(
    { name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(input)
  ));
  const token = input + "." + b64url(signature);
  const verifier = await MissionTokenVerifier.fromBase64UrlPublicKey(b64url(rawPublic));
  return { pair, payload, token, verifier };
}

test("1. acepta únicamente un Mission Token Ed25519 válido y acotado", async () => {
  const f = await fixture();
  const verified = await f.verifier.verify(f.token);
  assert.equal(verified.tenantId, "tenant-42");
  assert.equal(verified.action, "recovery_diagnosis");
});

test("2. rechaza una firma alterada antes de confiar en los claims", async () => {
  const f = await fixture();
  const parts = f.token.split(".");
  const forgedPayload = encode({ ...f.payload, tenantId: "tenant-victim" });
  await assert.rejects(f.verifier.verify(parts[0] + "." + forgedPayload + "." + parts[2]),
    /mission_token_signature_invalid/);
});

test("3. rechaza un token con permiso cruzado de otra acción", async () => {
  const f = await fixture({ action: "chat" as any });
  await assert.rejects(f.verifier.verify(f.token), /mission_token_scope_invalid/);
});

test("4. rechaza token vencido o con vida superior a 15 minutos", async () => {
  const expired = await fixture({ exp: Math.floor(Date.now() / 1000) - 1 });
  await assert.rejects(expired.verifier.verify(expired.token), /mission_token_expired_or_lifetime_invalid/);
  const tooLong = await fixture({ exp: Math.floor(Date.now() / 1000) + 901 });
  await assert.rejects(tooLong.verifier.verify(tooLong.token), /mission_token_expired_or_lifetime_invalid/);
});

test("5. ReplayGuard binding ausente falla cerrado", async () => {
  const f = await fixture();
  const gate = new ControlGate({} as any);
  const result = await gate.consumeMissionToken(await f.verifier.verify(f.token));
  assert.deepEqual(result, { ok: false, status: 503, reason: "mission_replay_guard_unavailable" });
});

test("6. un jti verificado se consume una sola vez", async () => {
  const f = await fixture();
  const seen = new Set<string>();
  const namespace = {
    idFromName: (name: string) => name,
    get: (_id: string) => ({
      fetch: async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (seen.has(body.jti)) return Response.json({ fresh: false }, { status: 409 });
        seen.add(body.jti);
        return Response.json({ fresh: true });
      },
    }),
  };
  const gate = new ControlGate({ REPLAY_GUARD: namespace } as any);
  const payload = await f.verifier.verify(f.token);
  assert.deepEqual(await gate.consumeMissionToken(payload), { ok: true });
  assert.deepEqual(await gate.consumeMissionToken(payload), {
    ok: false, status: 403, reason: "mission_token_replay"
  });
});

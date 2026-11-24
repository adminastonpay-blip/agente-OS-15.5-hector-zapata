import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { MissionTokenVerifier, hashRecoveryMission, type MissionTokenPayload } from "../src/core/mission-token.ts";
import { ControlGate } from "../src/core/control-gate.ts";
import { ReplayGuard } from "../src/core/replay-guard.ts";

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
  const missionHash = await hashRecoveryMission({
    missionId: "mission-2026-0001",
    origin: "https://api.example.test/health",
    poolId: "pool-42",
    errorCode: 503,
    severity: "high",
  });
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
    missionHash,
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
  const gate = new ControlGate({
    REPLAY_GUARD: namespace,
    INTERNAL_ASSERTION_SECRET: "unit-test-secret-1234567890",
    INTERNAL_ASSERTION_KEY_ID: "test-mission-token",
  } as any);
  const payload = await f.verifier.verify(f.token);
  assert.deepEqual(await gate.consumeMissionToken(payload), { ok: true });
  assert.deepEqual(await gate.consumeMissionToken(payload), {
    ok: false, status: 403, reason: "mission_token_replay"
  });
});

test("7. Durable Object rejects concurrent duplicate jti claims", async () => {
  const consumed = new Map<string, number>();
  let changes = 0;
  const sql = {
    exec(query: string, ...args: any[]) {
      if (query.startsWith("DELETE FROM consumed_mission_jti")) {
        const now = Number(args[0]);
        for (const [key, row] of consumed) if (row <= now) consumed.delete(key);
        changes = 0;
        return { toArray: () => [] };
      }
      if (query.startsWith("INSERT OR IGNORE INTO consumed_mission_jti")) {
        const jti = String(args[0]);
        if (consumed.has(jti)) changes = 0;
        else { consumed.set(jti, Number(args[1])); changes = 1; }
        return { toArray: () => [] };
      }
      if (query.includes("SELECT changes()")) {
        return { toArray: () => [{ inserted: changes }] };
      }
      return { toArray: () => [] };
    },
  };
  const guard = new ReplayGuard({ storage: { sql, transactionSync: (fn: () => unknown) => fn() } } as any);
  const now = Math.floor(Date.now() / 1000);
  const request = () => guard.fetch(new Request("https://replay.internal/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jti: "9f1c4d20-6b8a-4a31-9d20-0a2f5e6c7b81",
      exp: now + 300,
    }),
  }));
  const responses = await Promise.all([request(), request()]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
});

test("8. Durable Object rejects expired or overlong replay claims", async () => {
  const sql = { exec: () => ({ toArray: () => [{ inserted: 0 }] }) };
  const guard = new ReplayGuard({ storage: { sql, transactionSync: (fn: () => unknown) => fn() } } as any);
  const response = await guard.fetch(new Request("https://replay.internal/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jti: "9f1c4d20-6b8a-4a31-9d20-0a2f5e6c7b81",
      exp: Math.floor(Date.now() / 1000) - 1,
    }),
  }));
  assert.equal(response.status, 400);
});

test("9. mission digest binds origin, pool, error code and severity", async () => {
  const original = {
    missionId: "mission-2026-0001",
    origin: "https://api.example.test/health",
    poolId: "pool-42",
    errorCode: 503,
    severity: "high" as const,
  };
  const digest = await hashRecoveryMission(original);
  assert.equal(digest.length, 64);
  assert.notEqual(
    digest,
    await hashRecoveryMission({ ...original, origin: "https://other.example.test/health" })
  );
  assert.notEqual(
    digest,
    await hashRecoveryMission({ ...original, errorCode: 401 })
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { TokenIssuer } from "../src/core/token-issuer.ts";
import type { SignatureProvider } from "../src/core/signature-adapter.ts";
import { MissionTokenVerifier } from "../src/core/mission-token.ts";
import type { Identity } from "../src/types.ts";

const pairPromise = webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const identity: Identity = {
  actor: "admin-42", method: "access", tenant: "tenant-A",
  roles: ["RECOVERY_ADMIN"], clearance: "secret",
};
const mission = {
  missionId: "mission-2026-0001", tenantId: "tenant-A",
  origin: "https://api.example.test/health", poolId: "pool-42",
  errorCode: 503, severity: "high" as const,
};
const fixedJti = "9f1c4d20-6b8a-4a31-9d20-0a2f5e6c7b81";

async function setup(now = 1_800_000_000) {
  const pair = await pairPromise;
  const signer: SignatureProvider = {
    sign: async (data) => new Uint8Array(await webcrypto.subtle.sign(
      { name: "Ed25519" }, pair.privateKey, data
    )),
  };
  const rawPublic = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  const b64 = (bytes: Uint8Array) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  };
  const issuer = new TokenIssuer(signer, { now: () => now, createJti: () => fixedJti, allowedOrigins: ["https://api.example.test"] });
  const verifier = await MissionTokenVerifier.fromBase64UrlPublicKey(b64(rawPublic));
  return { issuer, verifier, now };
}

test("rechaza escalada: un usuario sin RECOVERY_ADMIN no obtiene token", async () => {
  const { issuer } = await setup();
  await assert.rejects(
    issuer.issueMissionToken({ ...identity, roles: ["USER"] }, mission),
    /unauthorized_recovery_admin_required/
  );
});

test("rechaza método de autenticación que no sea Access validado", async () => {
  const { issuer } = await setup();
  await assert.rejects(
    issuer.issueMissionToken({ ...identity, method: "apikey" }, mission),
    /unauthorized_recovery_admin_required/
  );
});

test("rechaza emisión cross-tenant", async () => {
  const { issuer } = await setup();
  await assert.rejects(
    issuer.issueMissionToken(identity, { ...mission, tenantId: "tenant-B" }),
    /unauthorized_recovery_tenant_mismatch/
  );
});

test("firma token válido aceptado por MissionTokenVerifier", async () => {
  const { issuer, verifier, now } = await setup();
  const token = await issuer.issueMissionToken(identity, mission);
  const claims = await verifier.verify(token);
  assert.equal(claims.iss, "aston-os-gateway");
  assert.equal(claims.sub, "admin-42");
  assert.equal(claims.tenantId, "tenant-A");
  assert.equal(claims.exp - claims.iat, 900);
  assert.equal(claims.missionId, mission.missionId);
  assert.equal(claims.iat, now);
});

test("rechaza misión con contexto inseguro o inválido antes de firmar", async () => {
  const { issuer } = await setup();
  await assert.rejects(
    issuer.issueMissionToken(identity, { ...mission, origin: "http://169.254.169.254/latest" }),
    /invalid_recovery_origin/
  );
});

test("rechaza origen HTTPS que no esté en la allowlist del emisor", async () => {
  const { issuer } = await setup();
  await assert.rejects(
    issuer.issueMissionToken(identity, { ...mission, origin: "https://attacker.example.test/health" }),
    /recovery_origin_not_allowlisted/
  );
});

test("un token emitido con reloj de ayer es rechazado por el verificador actual", async () => {
  const yesterday = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  const { issuer, verifier } = await setup(yesterday);
  const token = await issuer.issueMissionToken(identity, mission);
  await assert.rejects(verifier.verify(token), /mission_token_expired_or_lifetime_invalid/);
});

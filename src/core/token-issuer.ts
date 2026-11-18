import type { Identity } from "../types.ts";
import { hashRecoveryMission, type MissionTokenPayload } from "./mission-token.ts";

export interface RecoveryMissionContext {
  missionId: string;
  tenantId: string;
  origin: string;
  poolId: string;
  errorCode: number;
  severity: "low" | "medium" | "high" | "critical";
}

/**
 * Signing boundary for a protected Ed25519 key service (KMS/HSM adapter).
 * Implementations must never export or log private key material.
 */
export interface Ed25519MissionSigner {
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export interface TokenIssuerOptions {
  now?: () => number;
  createJti?: () => string;
}

const ISSUER = "aston-os-gateway";
const AUDIENCE = "recovery-workflow";
const ACTION = "recovery_diagnosis";
const MAX_LIFETIME_SECONDS = 15 * 60;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function validateMission(mission: RecoveryMissionContext): void {
  if (!mission || typeof mission.missionId !== "string" ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(mission.missionId)) {
    throw new Error("invalid_recovery_mission_id");
  }
  if (typeof mission.tenantId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(mission.tenantId)) {
    throw new Error("invalid_recovery_tenant");
  }
  if (typeof mission.origin !== "string" || mission.origin.length > 2048) {
    throw new Error("invalid_recovery_origin");
  }
  let parsed: URL;
  try { parsed = new URL(mission.origin); } catch {
    throw new Error("invalid_recovery_origin");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("invalid_recovery_origin");
  }
  if (typeof mission.poolId !== "string" || !mission.poolId.trim() ||
      mission.poolId.length > 128 || !Number.isSafeInteger(mission.errorCode) ||
      !["low", "medium", "high", "critical"].includes(mission.severity)) {
    throw new Error("invalid_recovery_mission_context");
  }
}

export class TokenIssuer {
  private readonly now: () => number;
  private readonly createJti: () => string;

  constructor(
    private readonly signer: Ed25519MissionSigner,
    options: TokenIssuerOptions = {},
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.createJti = options.createJti ?? (() => crypto.randomUUID());
  }

  async issueMissionToken(
    adminIdentity: Identity,
    mission: RecoveryMissionContext,
  ): Promise<string> {
    // Identity must come from the already-validated server authentication layer.
    if (!adminIdentity || adminIdentity.method !== "access" ||
        !Array.isArray(adminIdentity.roles) ||
        !adminIdentity.roles.includes("RECOVERY_ADMIN")) {
      throw new Error("unauthorized_recovery_admin_required");
    }
    if (typeof adminIdentity.actor !== "string" || !adminIdentity.actor.trim() ||
        adminIdentity.actor.length > 128) {
      throw new Error("unauthorized_recovery_identity_invalid");
    }
    if (adminIdentity.tenant !== mission?.tenantId) {
      throw new Error("unauthorized_recovery_tenant_mismatch");
    }

    validateMission(mission);
    const iat = this.now();
    const jti = this.createJti();
    if (!Number.isSafeInteger(iat) || !UUID_V4.test(jti)) {
      throw new Error("mission_token_issuer_clock_or_jti_invalid");
    }
    const exp = iat + MAX_LIFETIME_SECONDS;
    const missionHash = await hashRecoveryMission({
      missionId: mission.missionId,
      origin: mission.origin,
      poolId: mission.poolId,
      errorCode: mission.errorCode,
      severity: mission.severity,
    });
    const payload: MissionTokenPayload = {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: adminIdentity.actor,
      tenantId: adminIdentity.tenant,
      action: ACTION,
      jti,
      iat,
      exp,
      missionId: mission.missionId,
      missionHash,
    };
    const signingInput = encodeJson({ alg: "EdDSA", typ: "JWT" }) + "." + encodeJson(payload);
    const signature = await this.signer.sign(new TextEncoder().encode(signingInput));
    if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
      throw new Error("mission_token_signer_invalid_signature");
    }
    return signingInput + "." + base64UrlEncode(signature);
  }
}

/**
 * Ed25519 JWT verifier for narrowly scoped Recovery missions.
 * The public key is configured out-of-band; tokens never select their own key.
 */
export interface MissionTokenPayload {
  iss: "aston-os-gateway";
  aud: "recovery-workflow";
  sub: string;
  tenantId: string;
  action: "recovery_diagnosis";
  jti: string;
  iat: number;
  exp: number;
  missionId: string;
}

type JwtHeader = { alg: "EdDSA"; typ: "JWT" };

const ISSUER = "aston-os-gateway";
const AUDIENCE = "recovery-workflow";
const MAX_LIFETIME_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 30;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decodeBase64Url(segment: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error("mission_token_malformed");
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("mission_token_malformed");
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // Reject non-canonical encodings to keep one textual representation per token.
  if (encodeBase64Url(bytes) !== segment) throw new Error("mission_token_malformed");
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function parseJson<T>(bytes: Uint8Array): T {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new Error("mission_token_malformed");
  }
}

export class MissionTokenVerifier {
  constructor(private readonly publicKey: CryptoKey) {}

  static async fromBase64UrlPublicKey(encodedKey: string): Promise<MissionTokenVerifier> {
    if (!encodedKey?.trim()) throw new Error("mission_token_public_key_missing");
    const raw = decodeBase64Url(encodedKey.trim());
    if (raw.byteLength !== 32) throw new Error("mission_token_public_key_invalid");
    const key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return new MissionTokenVerifier(key);
  }

  async verify(token: string): Promise<MissionTokenPayload> {
    if (typeof token !== "string" || token.length > 8192) {
      throw new Error("mission_token_invalid");
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) {
      throw new Error("mission_token_malformed");
    }

    const header = parseJson<JwtHeader>(decodeBase64Url(parts[0]));
    if (!header || header.alg !== "EdDSA" || header.typ !== "JWT" ||
        Object.keys(header).some((key) => key !== "alg" && key !== "typ")) {
      throw new Error("mission_token_algorithm_rejected");
    }

    const signingInput = new TextEncoder().encode(parts[0] + "." + parts[1]);
    const signature = decodeBase64Url(parts[2]);
    if (signature.byteLength !== 64 ||
        !(await crypto.subtle.verify({ name: "Ed25519" }, this.publicKey, signature, signingInput))) {
      throw new Error("mission_token_signature_invalid");
    }

    const payload = parseJson<MissionTokenPayload>(decodeBase64Url(parts[1]));
    const now = Math.floor(Date.now() / 1000);
    if (!payload || payload.iss !== ISSUER || payload.aud !== AUDIENCE ||
        payload.action !== "recovery_diagnosis") {
      throw new Error("mission_token_scope_invalid");
    }
    if (typeof payload.sub !== "string" || !payload.sub.trim() || payload.sub.length > 128 ||
        typeof payload.tenantId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(payload.tenantId) ||
        typeof payload.missionId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(payload.missionId) ||
        typeof payload.jti !== "string" || !UUID_V4.test(payload.jti) ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) {
      throw new Error("mission_token_claims_invalid");
    }
    if (payload.iat > now + CLOCK_SKEW_SECONDS || payload.exp <= now ||
        payload.exp <= payload.iat || payload.exp - payload.iat > MAX_LIFETIME_SECONDS) {
      throw new Error("mission_token_expired_or_lifetime_invalid");
    }
    return payload;
  }
}

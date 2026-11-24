/**
 * ASTON native attestation primitives.
 *
 * Signs canonical JSON bytes with Ed25519 and hashes payloads with SHA-256.
 * Private PKCS#8 key material must be supplied by a Worker secret binding;
 * never persist or return it. External transparency anchoring (OTS) is
 * intentionally out of process and is not implied by a local signature.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface AttestationEnvelope {
  schema_version: "1.0.0";
  attestation_id: string;
  algorithm: "Ed25519";
  key_id: string;
  payload_digest: { algorithm: "sha-256"; value: string };
  payload: JsonValue;
  signature: string;
  signed_at: string;
  transparency: { anchor_status: "not_submitted" };
}

export interface InternalAssertionClaims {
  iss: string;
  aud: string;
  sub_tenant: string;
  sub_actor: string;
  sub_agent?: string;
  sub_credential?: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface InternalAssertionEnvelope {
  v: 1;
  alg: "HS256";
  kid: string;
  claims: InternalAssertionClaims;
  sig: string;
}

export const MAX_INTERNAL_ASSERTION_TTL_MS = 15_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ED25519: any = { name: "Ed25519" };

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

function normalize(value: unknown, seen: Set<object>): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("attestation_non_finite_number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new TypeError("attestation_non_json_value");
  }
  if (seen.has(value)) throw new TypeError("attestation_circular_reference");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) throw new TypeError("attestation_sparse_array");
        result.push(normalize(value[i], seen));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("attestation_non_plain_object");
    }
    const source = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) throw new TypeError("attestation_undefined_value");
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError("attestation_unsafe_object_key");
      }
      result[key] = normalize(source[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Deterministic JSON representation for the supported JSON data model. */
export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(normalize(value, new Set<object>()));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/[+]/g, "-").replace(/[/]/g, "_");
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("attestation_invalid_base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Import an Ed25519 private key from PKCS#8 bytes (e.g. decoded Worker secret). */
export async function importEd25519PrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  if (!(pkcs8 instanceof Uint8Array) || pkcs8.byteLength < 32 || pkcs8.byteLength > 4096) {
    throw new TypeError("attestation_invalid_private_key");
  }
  return crypto.subtle.importKey("pkcs8", toArrayBuffer(pkcs8), ED25519, false, ["sign"]);
}

/** Import a raw 32-byte Ed25519 public key for local signature verification. */
export async function importEd25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  if (!(raw instanceof Uint8Array) || raw.byteLength !== 32) {
    throw new TypeError("attestation_invalid_public_key");
  }
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), ED25519, false, ["verify"]);
}

/** Verify an Ed25519 Proof-of-Possession signature over canonical JSON or raw bytes. */
export async function verifyEd25519ProofOfPossession(
  publicKey: CryptoKey,
  message: unknown | Uint8Array,
  signatureBase64Url: string
): Promise<boolean> {
  try {
    if (!publicKey || typeof signatureBase64Url !== "string" || !signatureBase64Url) return false;
    const sigBytes = fromBase64Url(signatureBase64Url);
    if (sigBytes.byteLength !== 64) return false;
    const msgBytes = message instanceof Uint8Array
      ? message
      : encoder.encode(canonicalizeJson(message));
    return await crypto.subtle.verify(ED25519, publicKey, toArrayBuffer(sigBytes), toArrayBuffer(msgBytes));
  } catch {
    return false;
  }
}

async function importHmacSha256Key(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new TypeError("internal_assertion_secret_invalid");
  }
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Sign a short-lived internal assertion (TTL <= 15s) bound to keyId and audience. */
export async function signInternalAssertion(
  claims: Omit<InternalAssertionClaims, "iat" | "exp" | "jti"> & {
    jti?: string;
    iat?: number;
    ttlMs?: number;
  },
  secret: string,
  keyId: string
): Promise<string> {
  if (!keyId || keyId.length > 256) throw new TypeError("internal_assertion_invalid_kid");
  if (!claims.iss || !claims.aud || !claims.sub_tenant || !claims.sub_actor) {
    throw new TypeError("internal_assertion_missing_claims");
  }
  const ttlMs = claims.ttlMs ?? MAX_INTERNAL_ASSERTION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_INTERNAL_ASSERTION_TTL_MS) {
    throw new RangeError("internal_assertion_ttl_exceeds_15s");
  }
  const nowMs = claims.iat ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new TypeError("internal_assertion_invalid_iat");
  }
  const fullClaims: InternalAssertionClaims = {
    iss: claims.iss,
    aud: claims.aud,
    sub_tenant: claims.sub_tenant,
    sub_actor: claims.sub_actor,
    ...(claims.sub_agent ? { sub_agent: claims.sub_agent } : {}),
    ...(claims.sub_credential ? { sub_credential: claims.sub_credential } : {}),
    jti: claims.jti ?? crypto.randomUUID(),
    iat: nowMs,
    exp: nowMs + ttlMs,
  };
  const payloadB64 = toBase64Url(encoder.encode(canonicalizeJson(fullClaims)));
  const headerAndPayload = `${keyId}.${payloadB64}`;
  const key = await importHmacSha256Key(secret);
  const sigBuf = await crypto.subtle.sign("HMAC", key, toArrayBuffer(encoder.encode(headerAndPayload)));
  return `v1.${headerAndPayload}.${toBase64Url(new Uint8Array(sigBuf))}`;
}

/** Verify an HMAC-SHA256 internal assertion with strict kid, audience, and <=15s TTL checks. */
export async function verifyInternalAssertion(
  token: string,
  secret: string,
  expectedKeyId: string,
  expectedAud: string,
  nowMs = Date.now(),
  skewMs = 2_000
): Promise<{ ok: true; claims: InternalAssertionClaims

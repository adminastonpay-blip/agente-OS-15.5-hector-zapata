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

const encoder = new TextEncoder();
const ED25519 = { name: "Ed25519" } as AlgorithmIdentifier;

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
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\\+/g, "-").replace(/\\//g, "_");
}

function fromBase64Url(value: string): Uint8Array {
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
  return crypto.subtle.importKey("pkcs8", pkcs8, ED25519, false, ["sign"]);
}

/** Import a raw 32-byte Ed25519 public key for local signature verification. */
export async function importEd25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  if (!(raw instanceof Uint8Array) || raw.byteLength !== 32) {
    throw new TypeError("attestation_invalid_public_key");
  }
  return crypto.subtle.importKey("raw", raw, ED25519, false, ["verify"]);
}

export async function signAttestation(
  payload: unknown,
  privateKey: CryptoKey,
  keyId: string,
  attestationId: string,
  signedAt = new Date().toISOString(),
): Promise<AttestationEnvelope> {
  if (!keyId || keyId.length > 1024) throw new TypeError("attestation_invalid_key_id");
  if (!attestationId || attestationId.length > 256) throw new TypeError("attestation_invalid_id");
  if (!Number.isFinite(Date.parse(signedAt))) throw new TypeError("attestation_invalid_signed_at");
  const canonicalPayload = canonicalizeJson(payload);
  const bytes = encoder.encode(canonicalPayload);
  const digest = await sha256Hex(bytes);
  const signature = await crypto.subtle.sign(ED25519, privateKey, bytes);
  return {
    schema_version: "1.0.0",
    attestation_id: attestationId,
    algorithm: "Ed25519",
    key_id: keyId,
    payload_digest: { algorithm: "sha-256", value: digest },
    payload: JSON.parse(canonicalPayload) as JsonValue,
    signature: toBase64Url(new Uint8Array(signature)),
    signed_at: new Date(signedAt).toISOString(),
    transparency: { anchor_status: "not_submitted" },
  };
}

export async function verifyAttestation(
  envelope: AttestationEnvelope,
  publicKey: CryptoKey,
): Promise<boolean> {
  try {
    if (
      !envelope ||
      envelope.schema_version !== "1.0.0" ||
      envelope.algorithm !== "Ed25519" ||
      !envelope.key_id ||
      envelope.payload_digest?.algorithm !== "sha-256" ||
      !/^[a-f0-9]{64}$/.test(envelope.payload_digest.value) ||
      !Number.isFinite(Date.parse(envelope.signed_at))
    ) return false;
    const bytes = encoder.encode(canonicalizeJson(envelope.payload));
    const digest = await sha256Hex(bytes);
    if (digest !== envelope.payload_digest.value) return false;
    const signature = fromBase64Url(envelope.signature);
    if (signature.byteLength !== 64) return false;
    return await crypto.subtle.verify(ED25519, publicKey, signature, bytes);
  } catch {
    return false;
  }
}

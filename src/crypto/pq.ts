/**
 * Post-quantum identity helpers (ML-KEM / ML-DSA via webcrypto_modern_algorithms).
 * Falls back gracefully if the runtime does not expose PQC algorithms yet.
 */

function b64(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

export async function pqRuntimeProbe(): Promise<{
  ml_dsa: boolean;
  ml_kem: boolean;
  flag_hint: string;
}> {
  let ml_dsa = false;
  let ml_kem = false;
  try {
    const k = await crypto.subtle.generateKey("ML-DSA-65" as any, false, ["sign", "verify"]);
    ml_dsa = !!k;
  } catch {
    ml_dsa = false;
  }
  try {
    const k = await crypto.subtle.generateKey("ML-KEM-768" as any, false, [
      "encapsulateBits",
      "decapsulateBits",
    ] as any);
    ml_kem = !!k;
  } catch {
    ml_kem = false;
  }
  return {
    ml_dsa,
    ml_kem,
    flag_hint: "compatibility_flags = [\"nodejs_compat\", \"webcrypto_modern_algorithms\"]",
  };
}

export async function generateAgentIdentity() {
  const signingKeys = await crypto.subtle
    .generateKey("ML-DSA-65" as any, true, ["sign", "verify"])
    .then((key) => ("privateKey" in key ? (key as CryptoKeyPair) : null))
    .catch(() => null);
  const kemKeys = await crypto.subtle
    .generateKey("ML-KEM-768" as any, true, ["encapsulateBits", "decapsulateBits"] as any)
    .catch(() => null);

  // Classical fallback for environments without PQC
  let ecdsa: CryptoKeyPair | null = null;
  if (!signingKeys) {
    ecdsa = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
  }

  return {
    algorithm: signingKeys ? "ML-DSA-65" : "ECDSA-P-256",
    kem: kemKeys ? "ML-KEM-768" : null,
    signingKeys: signingKeys || ecdsa,
    kemKeys,
  };
}

export async function signAction(
  privateKey: CryptoKey,
  payload: string
): Promise<{ signature: string; alg: string }> {
  const data = new TextEncoder().encode(payload);
  try {
    const sig = await crypto.subtle.sign("ML-DSA-65" as any, privateKey, data);
    return { signature: b64(sig), alg: "ML-DSA-65" };
  } catch {
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data);
    return { signature: b64(sig), alg: "ECDSA-P-256" };
  }
}

export async function sealMessage(pub: CryptoKey, payload: string) {
  const subtle = crypto.subtle as SubtleCrypto & {
    encapsulateBits?: (
      algorithm: string,
      publicKey: CryptoKey
    ) => Promise<{ sharedKey: ArrayBuffer; ciphertext: ArrayBuffer }>;
  };
  if (typeof subtle.encapsulateBits !== "function") {
    throw new Error("ML-KEM encapsulation is not supported by this Workers runtime");
  }
  const { sharedKey, ciphertext } = await subtle.encapsulateBits("ML-KEM-768", pub);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", sharedKey, "AES-GCM", false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(payload)
  );
  return { ciphertext, iv, encrypted };
}

export async function generateAgentIdentity() {
  const signingKeys = await crypto.subtle.generateKey(
    "ML-DSA-65" as any, false, ["sign", "verify"]
  ).catch(() => null);
  const kemKeys = await crypto.subtle.generateKey(
    "ML-KEM-768" as any, false, ["encapsulateBits", "decapsulateBits"]
  ).catch(() => null);
  return { signingKeys, kemKeys };
}

export async function sealMessage(pub: CryptoKey, payload: string) {
  const { sharedKey, ciphertext } = await crypto.subtle.encapsulateBits(
    "ML-KEM-768" as any, pub
  ) as any;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", sharedKey, "AES-GCM", false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(payload)
  );
  return { ciphertext, iv, encrypted };
}

/**
 * Cryptographic signing boundary. Production implementations should delegate
 * to a non-exportable KMS/HSM key; this module deliberately contains no key material.
 */
export interface SignatureProvider {
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/** Test/development only. Never wire this provider to a production Worker. */
export class LocalDevSignatureProvider implements SignatureProvider {
  constructor(private readonly privateKey: CryptoKey) {
    if (privateKey.type !== "private" || !privateKey.usages.includes("sign")) {
      throw new Error("signature_provider_private_signing_key_required");
    }
    if (privateKey.algorithm.name !== "Ed25519") {
      throw new Error("signature_provider_ed25519_required");
    }
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.sign(
      { name: "Ed25519" }, this.privateKey, data
    ));
  }
}

/**
 * Adapter contract for a future AWS/GCP/Azure KMS implementation.
 * Implementations must map Ed25519 to a supported KMS algorithm and must fail
 * closed if the selected key/algorithm is incompatible. No cloud SDK is bundled.
 */
export interface RemoteKmsEd25519Client {
  signEd25519(keyId: string, data: Uint8Array): Promise<Uint8Array>;
}

export class KmsSignatureProvider implements SignatureProvider {
  constructor(
    private readonly client: RemoteKmsEd25519Client,
    private readonly keyId: string,
  ) {
    if (!keyId.trim()) throw new Error("kms_signature_key_id_required");
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    const signature = await this.client.signEd25519(this.keyId, data);
    if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
      throw new Error("kms_signature_invalid_ed25519_signature");
    }
    return signature;
  }
}

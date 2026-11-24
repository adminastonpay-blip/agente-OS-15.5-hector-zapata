# ASTON Trust Fabric and Decision Attestation

## Decision signing

Every SafetyInterlock policy result is signed before it is returned. The signed payload binds the tenant, actor, phase, uppercase decision (`ALLOW`, `DENY`, or `REQUIRE_APPROVAL`), proposed action, policy result, and optional approval ID. The envelope is persisted in the tenant's SafetyInterlock Durable Object and its ID and payload digest are copied into the append-only audit event and lineage record.

A human approval or rejection creates a second signed attestation (`ALLOW` or `DENY`, phase `human_approval`). If key material is missing, malformed, mismatched, or the local signature verification fails, the endpoint returns HTTP 503 and does not return an actionable decision. The transparency status remains `not_submitted`; a local Ed25519 signature is not an OpenTimestamps anchor.

## Key material

- `ATTESTATION_PRIVATE_KEY`: base64url-encoded Ed25519 PKCS#8 DER. Inject as a Cloudflare Worker secret. Never commit it or place it in `wrangler.toml`.
- `ATTESTATION_PUBLIC_KEY`: base64url-encoded raw 32-byte Ed25519 public key. Inject as a Worker variable (or secret if organizational policy requires).
- `ATTESTATION_KEY_ID`: stable, non-secret identifier such as `aston-ed25519-2026-11`.

Generate a dedicated key pair in a controlled operator environment:

```sh
openssl genpkey -algorithm Ed25519 -out aston-attestation-private.pem
openssl pkcs8 -topk8 -nocrypt -in aston-attestation-private.pem -outform DER | openssl base64 -A | tr '+/' '-_' | tr -d '='
openssl pkey -in aston-attestation-private.pem -pubout -outform DER | tail -c 32 | openssl base64 -A | tr '+/' '-_' | tr -d '='
```

The first encoded output is the private-key secret; the second is the public-key variable. Keep the PEM and the private DER out of source control, chat, build logs, and ordinary artifact storage.

Configure the production Worker from the repository root:

```sh
npx wrangler secret put ATTESTATION_PRIVATE_KEY
npx wrangler secret put ATTESTATION_PUBLIC_KEY
npx wrangler secret put ATTESTATION_KEY_ID
```

The public key and key ID are not cryptographic secrets; using Worker secrets for all three is a conservative operational choice. For local development, use a dedicated non-production key pair and local Wrangler secrets. Never reuse production keys in tests.

## Rotation procedure

1. Generate a new Ed25519 key pair in the controlled key-management environment.
2. Assign a new immutable key ID; never reuse an old ID for different key material.
3. Record the old public key, key ID, activation interval, and fingerprint in the evidence/key registry before changing the Worker.
4. Update `ATTESTATION_PUBLIC_KEY`, `ATTESTATION_KEY_ID`, and `ATTESTATION_PRIVATE_KEY` as one coordinated release, then deploy the Worker.
5. Run a signed decision smoke test and verify the returned envelope with the new public key before reopening governed actions.
6. Retain old public keys indefinitely (or for the evidence-retention period) so historical envelopes remain independently verifiable. Do not retain old private keys longer than the key-management policy requires.
7. If the Worker reports `decision_attestation_unavailable`, keep actions closed and roll forward or restore a matching key triplet. Do not bypass signing.

This first integration supports one active signing key per Worker deployment. A multi-key verification registry / overlap window is a follow-up; historical verification must select the public key by the envelope's `key_id` from the external registry.

## Trust Fabric

`src/core/trust-fabric.ts` contains the default-deny RBAC evaluator and policy rule contract. `src/do/trust-fabric.ts` stores tenant role grants and tenant policy overrides in SQLite-backed Durable Object storage. The Worker addresses the namespace using `tenant:<tenant-id>`; the DO pins its first tenant ID and rejects cross-tenant reuse.

Built-in `admin` and `executor` grants are evaluated before the existing risk/clearance policy. Tenant-specific explicit policy rules can allow, deny, or require approval. The TrustFabric management endpoints require a verified identity with the tenant's `admin` role and a matching tenant ID. The public request body is not an identity source.

The new `TRUST` binding is declared in production and isolated staging Wrangler configurations. Production deployment and secret provisioning are intentionally separate from this code change.

# ASTON Mission Token Issuer Contract

Status: **CONTRACT / IMPLEMENTATION GUIDE**. This document does not implement or deploy an issuer and does not authorize production signing.

## 1. Purpose and trust boundary

The Recovery endpoint accepts a short-lived Ed25519-signed JWT from the trusted ASTON gateway. The Recovery Worker verifies the signature with its separately configured `MISSION_TOKEN_PUBLIC_KEY`, validates the claims and mission digest, and consumes `jti` through the ReplayGuard Durable Object.

The private signing key MUST remain outside the Recovery Worker and MUST NOT be stored in this repository, source code, GitHub Actions variables, logs, client applications, or a general-purpose public signing endpoint. Use a managed KMS/HSM or an equivalently controlled signing service with non-exportable key material where available.

The issuer MUST authenticate and authorize the requesting principal before signing. It must derive `sub` and `tenantId` from authenticated server-side identity, never from untrusted request fields.

## 2. Required JWT profile

Protected header (no additional fields are currently accepted):

```json
{ "alg": "EdDSA", "typ": "JWT" }
```

Required claims:

| Claim | Required value / constraint |
|---|---|
| `iss` | `aston-os-gateway` |
| `aud` | `recovery-workflow` |
| `action` | `recovery_diagnosis` |
| `sub` | Authenticated actor identifier; non-empty, max 128 chars |
| `tenantId` | 1–64 chars matching `[A-Za-z0-9_-]` |
| `jti` | Fresh UUID v4 for every token |
| `iat` | Unix seconds; no more than 30 seconds in the future |
| `exp` | Unix seconds; future, after `iat`, lifetime no more than 900 seconds |
| `missionId` | 8–128 chars matching `[A-Za-z0-9._:-]` |
| `missionHash` | Lowercase 64-character SHA-256 hex digest (see below) |

The verifier currently accepts only EdDSA/Ed25519, JWT type JWT, and the exact issuer, audience and action above. Do not use `kid`, `jku`, `x5u`, algorithm negotiation, or token-selected key URLs; the current verifier does not implement key discovery or multi-key rotation.

## 3. Mission digest — exact byte contract

The issuer MUST calculate `missionHash` over this fixed-position JSON array, preserving the order and JSON types:

```ts
JSON.stringify([
  missionId,
  origin,
  poolId,
  errorCode,
  severity
])
```

Encode that string as UTF-8, calculate SHA-256, then encode the digest as lowercase hexadecimal (64 characters). Values must be exactly the same values that the Recovery request submits:

- `missionId`: string
- `origin`: canonical origin string accepted by the Recovery allowlist
- `poolId`: string
- `errorCode`: JSON number (not a numeric string)
- `severity`: one of `low`, `medium`, `high`, `critical`

Do not normalize, reorder, coerce, or reconstruct values differently between signing and request submission. A mismatch must fail closed.

## 4. Signing procedure

1. Authenticate the caller and authorize the specific Recovery diagnosis action for the identified tenant.
2. Validate all mission parameters server-side, including the Recovery origin allowlist.
3. Generate a cryptographically random UUID v4 `jti`; never reuse it.
4. Set `iat` to current Unix time and `exp` to a time no more than 900 seconds later.
5. Compute `missionHash` using section 3.
6. Serialize the protected header and claims as UTF-8 JSON; base64url-encode each without padding.
7. Sign the exact ASCII bytes `base64url(header) + "." + base64url(payload)` with Ed25519 using the protected private key.
8. Return the compact JWT only to the authenticated, authorized server-side caller over TLS. Never put it in URLs, analytics, browser storage, or logs.

The issuer must not provide a generic “sign arbitrary claims” API. Its API should expose a narrowly scoped Recovery authorization operation and construct every security-sensitive claim itself.

## 5. Public-key provisioning

The Recovery verifier expects `MISSION_TOKEN_PUBLIC_KEY` as unpadded base64url encoding of the raw 32-byte Ed25519 public key. Provision it out-of-band in the target Worker environment. Never provision or transmit the private key to the Recovery Worker.

Before enabling the route, verify that the public key corresponds to the issuer's active KMS/HSM key using a non-production test vector. A missing or malformed public key must keep Recovery unavailable (fail closed).

The current verifier supports one configured public key and has no `kid`/JWKS rotation support. Rotation therefore requires a planned coordinated cutover (or a separately reviewed multi-key verifier change); do not assume overlapping old/new keys are supported.

## 6. Replay, expiry and operational controls

- A token is single-use: the Recovery workflow consumes `jti` through ReplayGuard.
- Retry a failed mission with a newly authorized token and a new `jti`; never replay the previous token.
- Keep token lifetime at or below 15 minutes; prefer the shortest practical lifetime.
- Rate-limit issuer requests per authenticated actor and tenant.
- Audit issuance metadata (actor, tenant, mission ID, key version, timestamp, decision) but never log the JWT, signature, or private key.
- Alert on repeated authorization failures, invalid signatures, replay attempts, and abnormal issuance volume.
- Apply least privilege to the issuer's KMS/HSM signing permission; separate operators who approve access from services that perform signing where feasible.

## 7. Required issuer acceptance tests

Before connecting an issuer to Recovery, demonstrate:

1. Valid token verifies with the provisioned public key.
2. Wrong issuer, audience, action, tenant, actor, or mission digest is rejected.
3. Expired, future-dated, overlong, malformed, wrong-algorithm, and bad-signature tokens are rejected.
4. A token with a modified `origin`, `poolId`, `errorCode`, `severity`, or `missionId` fails mission binding.
5. Two concurrent attempts to consume the same `jti` result in exactly one success.
6. A new retry receives a new `jti`.
7. Issuer authorization failures never produce a token.
8. Private key material is not present in repository files, build artifacts, logs, client responses, or Worker configuration.

## 8. Current implementation boundary

The Recovery repository currently contains the verifier, mission hash function, replay guard, ControlGate integration, and Recovery workflow. This contract documents what a future trusted issuer must produce. It does **not** mean an issuer exists, a KMS/HSM is configured, `MISSION_TOKEN_PUBLIC_KEY` is provisioned, or an end-to-end staging/production flow has been validated.

Production status remains **NOT VALIDATED** until an independently controlled issuer is implemented, its public key is provisioned, and the complete authenticated issuance-to-Recovery path is exercised in isolated staging.

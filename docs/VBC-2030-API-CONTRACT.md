# ASTON VBC-2030 — API Contract (V1 proposal)

Status: proposed contract; endpoints are not implemented. All routes remain staging-only until independent security acceptance.

## POST /v1/certificate/issue

Authentication: verified Shopify App Proxy or issuer identity; role certificate:issue; tenant derived from verified identity. Required headers: Idempotency-Key (16–128 chars), Content-Type application/json.

Request: client may submit only schema and run_id. Client must not supply audit results, hashes, tenant, issuer identity, or Bitcoin status.

    {
      "schema": "aston.vbc.issue.request.v1",
      "run_id": "arp100-run-2026-000001"
    }

Server-side gates:
- Resolve run record from trusted registry.
- Verify tenant ownership and issuer authorization.
- Require terminal suite success and exact common source SHA across all mandatory controls.
- Reject pending, failed, stale, missing, or unjustified skipped controls.
- Enforce one issuance per run unless authorized reissue policy applies.
- Create immutable manifest and PDF; use external PAdES signing service.
- Verify signature before storing.
- Compute SHA-256 of exact final signed PDF.
- Submit OTS proof; pending is allowed only if certificate visibly says ANCHOR_PENDING.
- Store artifacts append-only and issue short-lived download capability.

Success response only after signed PDF and evidence have been stored:

    {
      "ok": true,
      "status": "ANCHOR_PENDING",
      "certificate_id": "VBC-2030-ABC123",
      "pdf_sha256": "<64 lowercase hex characters>",
      "download_url": "<short-lived authenticated URL>",
      "verification_url": "/verify/VBC-2030-ABC123"
    }

Never return ACTIVE until an independent verifier confirms the OTS proof against a Bitcoin block and current issuer/status checks pass.

## POST /v1/certificate/verify

Accept a certificate ID (server resolves stored artifacts) or bounded PDF + OTS proof upload. The verifier recomputes the PDF hash; it does not trust a client-supplied digest.

Response states: VERIFIED, ANCHOR_PENDING, INVALID, REVOKED, SUSPENDED, EXPIRED, UNTRUSTED_ISSUER, INDETERMINATE.

VERIFIED requires:
- PDF SHA-256 matches signed manifest and registry record.
- PAdES signature and certificate path validate under verifier trust policy.
- Revocation and validity checks pass.
- Manifest signature and audit provenance binding pass.
- Current signed status is active and fresh.
- OTS proof verifies for exact PDF digest and is anchored to a confirmed Bitcoin block.

## GET /v1/certificate/{certificate_id}

Returns public-safe metadata, current status, issuer key ID, PDF digest, proof state, and public verification links. Never returns tenant secrets, private evidence, private keys, or unrestricted R2 object URLs.

## GET /v1/certificate/{certificate_id}/status

Returns latest signed status statement plus monotonic sequence and prior statement digest. A verifier rejects rollback, stale, unsigned, or inconsistent status.

## POST /v1/certificate/{certificate_id}/suspend and /revoke

Require privileged issuer identity and dual authorization for high-assurance profiles. Append a signed status statement; never delete or rewrite original issuance evidence.

## Error semantics

- 400 malformed schema.
- 401 unauthenticated.
- 403 unauthorized or cross-tenant.
- 404 unknown/non-disclosable resource.
- 409 replay, conflicting idempotency key, or invalid state transition.
- 413 request exceeds strict size limit.
- 422 run not eligible or cryptographic validation failed.
- 429 rate limited.
- 503 required signing, archive, status, or verification dependency unavailable.

On 503, semantics are INDETERMINATE; never downgrade a failed dependency into a successful certificate.

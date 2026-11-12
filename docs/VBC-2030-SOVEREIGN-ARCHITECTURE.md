# ASTON VBC-2030 — Sovereign Trust & Verification Infrastructure

**Status:** design baseline, V1 Foundation; not production-ready.  
**Boundary:** isolated staging only. This specification does not change production Worker, live Shopify theme, Cloudflare resources, secrets, bindings, or deployment settings.

> Don't trust the issuer. Verify the evidence.

## 1. Purpose

VBC-2030 is a portable evidence-and-verification system. Any third party must be able to establish document integrity, issuer-signature validity, evidence provenance, current certificate status, and trusted time without relying on ASTON's dashboard or an assertion by the issuer.

A certificate attests to a defined audit run and evidence package. It is not a financial instrument, regulatory approval, ISO certification, guarantee of business performance, or proof that every underlying statement is true.

## 2. Trust claims and limits

| Claim | Required evidence | Does not prove |
|---|---|---|
| Document integrity | SHA-256 of exact final PDF bytes | Truth of contents |
| Issuer authenticity | PAdES signature, trusted issuer chain, revocation checks | Correctness of issuer claims |
| Audit provenance | Signed canonical manifest, immutable run record, evidence digests, source revision | Honesty of every source system |
| Time existence | OpenTimestamps proof independently verified to a Bitcoin block | Exact creation time; Bitcoin proves existence no later than block time |
| Current status | Signed status/revocation statement with sequence and freshness | That a revoked certificate never existed |
| Physical binding | Unique serial, tamper-evident features, registry record | Resistance to every sophisticated forgery |

No UI state, progress animation, unsigned JSON, HTTP 200, or pending OTS receipt is a trust proof.

## 3. V1 architecture

1. **Audit Run Authority:** accepts only server-generated run IDs. A run is eligible only after the configured ARP suite completes, all mandatory controls are PASS on one immutable source revision, and an authorized policy evaluator seals the result.
2. **Evidence Manifest Builder:** creates canonical JSON with certificate ID, tenant pseudonym, run ID, suite/version, source revision, evidence digests, test outcomes, issuer key ID, timestamps, and policy profile.
3. **PDF Renderer:** renders the human-readable certificate. It must not claim Bitcoin anchoring before proof confirmation.
4. **PAdES Signing Service:** performs a real PDF signature with a protected private key in an HSM or managed signing service. pdf-lib may render the PDF; it is not by itself a PAdES signer.
5. **Finalization:** validate PAdES, complete the selected profile and DSS/LTV material, then freeze the exact final PDF bytes.
6. **Digest and timestamp:** calculate SHA-256 over the exact final signed PDF bytes. Submit that digest to OpenTimestamps. Pending proofs are upgraded asynchronously.
7. **Evidence Vault:** store final PDF, canonical manifest, detached manifest signature, OTS receipt, issuer-chain material, status records, and validation report in staging R2 under immutable/content-addressed keys.
8. **Independent Verifier:** recomputes PDF digest, validates PAdES and trust chain, checks manifest binding and current status, and verifies OTS against Bitcoin headers through an independently operated verifier.
9. **Shopify Console:** authenticated presentation/orchestration only. It cannot create successful audit results or assert validity from browser state.

## 4. Non-circular issuance sequence

1. Resolve and authorize run ID from the server-side audit registry.
2. Require all mandatory ARP-100 controls terminal PASS on the same immutable run revision. Reject pending, failed, unjustifiably skipped, stale, or unverifiable results.
3. Build a canonical manifest draft and render a PDF containing certificate ID, audit scope, issuer identity, and manifest ID. Do not embed the final PDF hash inside the PDF itself.
4. Sign using a PAdES-capable signer and complete the selected long-term validation profile.
5. Re-open and validate the PDF signature and certificate chain.
6. Freeze final PDF bytes and calculate pdf_sha256.
7. Create the OTS proof for that exact digest. It may initially be pending.
8. Store artifacts using immutable/content-addressed keys. Never overwrite a previously issued artifact.
9. Publish a signed issuance record. If OTS is pending, status is ANCHOR_PENDING; never say “anchored in Bitcoin”.
10. After independent Bitcoin confirmation, publish an append-only status statement ACTIVE with block evidence. Do not mutate the original manifest.
11. Return a short-lived download capability only after authorization and artifact checks. Prefer authenticated download or a short-lived capability token, not a permanent public R2 URL.

The PDF digest is calculated after every PDF mutation, including PAdES DSS/LTV finalization. Any later byte change creates a different digest and requires a new proof.

## 5. Artifact model

- Final signed PDF: exact bytes are hashed.
- Canonical manifest JSON: deterministic serialization and explicit schema version.
- Detached manifest signature: signature over canonical manifest bytes.
- OpenTimestamps receipt: proof for the final PDF SHA-256 digest.
- Issuer chain: public certificate chain and trust metadata; never private keys.
- Status statements: append-only signed issuance, suspension, revocation, or supersession records.
- Verification report: machine-readable result with verifier version and evidence references.

## 6. Cryptographic policy

- V1 content digest: SHA-256.
- PDF signature: standards-conformant PAdES profile selected by policy; validate ByteRange, CMS signature, certificate path, key usage, revocation, and trusted time.
- Key custody: HSM or managed signing service. No private signing key in Liquid, browser JavaScript, Worker source, ordinary environment variables, or repository secrets.
- RFC 3161 timestamping is separate from OpenTimestamps and is used only with a trusted TSA and selected PAdES profile.
- OTS is PENDING until independently upgraded and verified against a Bitcoin block. Successful submission is not confirmation.
- Algorithm agility: manifest records algorithm identifiers and profile versions. New algorithms require migration and dual-verification periods.
- Post-quantum readiness is a separate tested migration track. Do not claim ML-DSA/PQC compliance until signer, PDF profile, certificate ecosystem, verifier, and interoperability are demonstrated.

## 7. Verification states

- VERIFIED — PDF digest, PAdES, issuer chain, manifest binding, current status, and OTS Bitcoin proof all pass.
- ANCHOR_PENDING — integrity/signature may pass, but OTS has no confirmed Bitcoin block.
- INVALID — cryptographic mismatch, invalid signature, manifest mismatch, or invalid proof.
- REVOKED — certificate or issuer status is revoked.
- SUSPENDED — current signed status suspends reliance.
- EXPIRED — applicable validity period ended.
- UNTRUSTED_ISSUER — signature is mathematically valid but issuer is not trusted under verifier policy.
- INDETERMINATE — required evidence/service is unavailable or cannot be conclusively evaluated.

The UI must distinguish INVALID from INDETERMINATE. An outage is not proof of forgery and is never a pass.

## 8. Proposed API surface (not implemented)

- POST /v1/certificate/issue — authenticated issuer action; accepts run_id and idempotency key only. Server resolves all evidence.
- GET /v1/certificate/{certificate_id} — public-safe metadata and current signed status.
- GET /v1/certificate/{certificate_id}/artifacts — authenticated or short-lived artifact access.
- POST /v1/certificate/verify — independently verifies PDF, signature, manifest, status, and OTS.
- GET /v1/certificate/{certificate_id}/status — current signed status statement and sequence.
- POST /v1/certificate/{certificate_id}/revoke — authorized, dual-controlled status transition.
- POST /v1/certificate/{certificate_id}/suspend — authorized emergency suspension.
- GET /.well-known/aston-vbc-issuer.json — issuer metadata, supported algorithms, key IDs, and trust-policy links.

All endpoints require bounded bodies, strict schemas, tenant isolation, rate limiting, no-store policy for sensitive responses, audit logging, and fail-closed authorization.

## 9. Storage and integrity

Use a dedicated staging R2 bucket and append-only object keys derived from content digests and certificate IDs. R2 retention/Object Lock configuration must be independently read back and tested; a repository declaration is not proof of account configuration. Retention reduces accidental deletion but does not defeat a privileged account administrator who can change bucket policy. Keep independent proof copies and restrict administrative roles.

Minimize personal/customer data. Use tenant pseudonyms and disclose only what the verification use case requires.

## 10. V1 release gates

- [ ] Server-side audit-run registry persists terminal outcomes and exact source SHA.
- [ ] Issuance authorization and tenant isolation tests pass.
- [ ] Replay/idempotency and duplicate-issuance tests pass.
- [ ] PDF rendering is deterministic or nondeterminism is recorded.
- [ ] PAdES validates with at least two independent validators.
- [ ] Issuer chain, key usage, revocation, and trusted-time checks pass.
- [ ] Exact final PDF SHA-256 is anchored and independently verified against a confirmed Bitcoin block.
- [ ] R2 writes, immutable keys, retention, and read-back are tested in staging.
- [ ] Independent verifier passes positive and adversarial test vectors.
- [ ] Shopify App Proxy signature and session/tenant authorization are verified server-side.
- [ ] CI checks all run on the same release-candidate HEAD SHA.
- [ ] Independent security review accepts the threat model.
- [ ] No production deployment or live-theme change is implied by staging acceptance.

## 11. Prohibited claims

VBC-2030 V1 does not issue bonds, securities, sovereign debt, regulatory certifications, ISO certificates, bank-grade assurances, or guarantees of audit correctness. It does not claim ISO 14298 printer certification, PAdES compliance, Bitcoin anchoring, or legal admissibility until independently demonstrated.

## 12. Existing implementation boundary

The branch feat/vbc2030-v1-ui-foundation contains a Shopify UI prototype and a browser verifier prototype. The dashboard progress animation is explicitly a demo and cannot authorize issuance. The verifier must not show VERIFIED unless a real backend independently validates signature, manifest, status, and OTS proof.

This document is an architecture specification. It does not add issuance routes, signer credentials, Cloudflare bindings, or deployment configuration.

# ASTON VBC-2030 — Threat Model

Status: V1 staging design baseline; not a security certification.

## Assets

1. Final signed PDF bytes and SHA-256 digest.
2. Canonical evidence manifest and detached manifest signature.
3. Issuer private signing key and public trust chain.
4. Audit-run records, per-control results, source SHA, and evidence objects.
5. OpenTimestamps receipts and Bitcoin confirmation evidence.
6. Certificate status/revocation history.
7. Tenant identity, authorization decisions, and private customer data.
8. Shopify session and App Proxy authentication material.

## Trust boundaries

- Shopify browser ↔ Shopify App Proxy.
- App Proxy ↔ staging Worker API.
- Worker ↔ audit-run registry and SafetyInterlock.
- Worker ↔ signing service/HSM.
- Worker ↔ R2 evidence vault.
- OTS submission/upgrade service ↔ Bitcoin network.
- Public verifier ↔ independent OTS/Bitcoin verifier.
- Issuer trust store ↔ verifier policy.
- ASTON operator ↔ Cloudflare account administration.

No boundary is trusted merely because it belongs to the same organization.

## Threats and required controls

| Threat | Required control | Negative test |
|---|---|---|
| Forged run ID | Resolve run server-side; never trust browser claims | Random, guessed, cross-tenant and incomplete run IDs must be rejected |
| Stale/mixed audit checks | Bind every control to one immutable source SHA and run ID | Mix PASS results from two SHAs; issuance rejects |
| Client-side progress spoofing | Progress is informational; backend run state is authoritative | Set browser state to 100%; no certificate is issued |
| Tenant substitution | Derive tenant from verified identity/App Proxy context | Alter tenant header/body; deny or isolate |
| Unauthorized issuance | Issuer role, verified session, policy gate, rate limit | Anonymous/read-only users cannot issue |
| Replay/double issue | Idempotency key and atomic immutable state transition | Replay and concurrent issue requests |
| PDF substitution | Hash exact final signed bytes and bind digest in manifest/status | Change one PDF byte; verification fails |
| Signature forgery | PAdES validation, trusted issuer chain, revocation and key usage | Invalid CMS, wrong key, expired/revoked cert |
| Key compromise | HSM/KMS, dual control, rotation, revocation, incident status | Revoke key; status changes per policy |
| OTS pending misrepresented | Distinct pending/confirmed state; independent Bitcoin verification | Unconfirmed proof never returns VERIFIED |
| OTS proof for different digest | Verify proof against locally recomputed PDF digest | Valid proof for another file is rejected |
| Manifest tampering | Canonical serialization and detached issuer signature | Alter any field; signature fails |
| R2 overwrite/delete | Content-addressed keys, retention read-back, restricted admin, independent copies | Attempt overwrite/delete; record outcome |
| Privileged account compromise | Separate bucket-policy, signing, and issuer admins; external proof copies | Tabletop role-misuse exercise |
| Verifier outage | Return INDETERMINATE, never pass | Disable verifier; no verified status |
| QR replacement/counterfeit | Resolve certificate ID and compare serial/status; tamper-evident print | Cloned QR cannot establish physical authenticity |
| Privacy leakage | Data minimization, tenant pseudonyms, public/private manifest split | Scan public API for PII and cross-tenant leakage |
| Dependency compromise | Pinned versions, lockfile, provenance, SBOM, vulnerability scan | CI rejects unpinned/vulnerable dependency |
| Algorithm obsolescence | Algorithm IDs, key rollover, archival revalidation | Verify historical certificate after key transition |

## Security invariants

- Fail closed for authorization, tenant binding, issuer trust, signature, manifest binding, and cryptographic mismatches.
- Return indeterminate (not valid) when a required verifier or evidence source is unavailable.
- A pending OTS proof is never described as Bitcoin-confirmed.
- A hash proves byte equality only; it does not prove authorship or truth.
- A valid signature proves control of a signing key under the trust policy; it does not prove signed statements are true.
- A Bitcoin timestamp proves a digest existed no later than the block timestamp; it does not prove exact creation time, identity, data availability, or audit quality.
- No signing private key enters Shopify Liquid, browser JavaScript, Git, or ordinary Worker environment variables.
- No certificate is issued from UI-only simulation or an unpersisted audit run.
- Every state transition is append-only and attributable to an authenticated actor.
- Production and staging resources, keys, identities, and object namespaces remain separate.

## Mandatory adversarial tests

1. Unknown run ID.
2. Successful run ID from a different tenant.
3. Run with one failed control.
4. Run with one pending control.
5. Skipped control without approved waiver.
6. Controls passing on mixed source SHAs.
7. Source branch moves after audit completion.
8. Same idempotency key repeated.
9. Different payload reuses same idempotency key.
10. Concurrent issue requests for one run.
11. Tampered PDF after issuance.
12. OTS proof for another PDF.
13. OTS proof still pending.
14. OTS proof that cannot be upgraded.
15. Signature valid mathematically but issuer untrusted.
16. Revoked/expired issuer certificate.
17. Missing verifier service.
18. R2 write succeeds but status publication fails.
19. Status publication succeeds but download URL generation fails.
20. Invalid or stale App Proxy signature.
21. Cross-tenant download attempt.
22. Certificate revoked after issuance.
23. Key rotation and historical verification.
24. Oversized/malformed PDF and OTS inputs.
25. Public verifier privacy and rate-limit checks.

## Acceptance rule

V1 passes only when every mandatory positive and negative test has an immutable CI result tied to the exact release candidate SHA, a reviewer approves the evidence, and all required external services are independently verified. A green dashboard or successful build alone is insufficient.

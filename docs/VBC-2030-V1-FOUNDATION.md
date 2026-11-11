# ASTON VBC-2030 — V1 Foundation readiness

Status: UI prototype committed to an isolated feature branch. Worker certificate issuance is intentionally NOT enabled.

## Scope implemented

- Portable Shopify Liquid section at `shopify/sections/aston-vbc-dashboard.liquid`.
- Independent verification page prototype at `verification/verify.html`.
- The Shopify section defaults to a visibly labeled progress simulation. The generated `demo-*` run identifier is not an audit result and cannot be accepted for certificate issuance.
- The dashboard calls a same-origin Shopify App Proxy path (`/apps/aston-vbc/certificate/issue` by default). It never sends Cloudflare credentials or signing keys to the browser.
- The verifier calculates the uploaded PDF SHA-256 locally and submits the digest plus OTS receipt to a verifier API. It reports VERIFIED only if the API returns all required positive flags. A hash calculation alone is not Bitcoin verification.

## Current repository facts

- The current staging Worker has an `AUDIT_ARCHIVE` R2 binding in `wrangler.staging.toml`.
- `OTS_VERIFIER` is optional in the Env type and is not bound in `wrangler.staging.toml`.
- Existing OTS verification is for audit-chain checkpoints through `verifyExternalOtsAnchor`; it is not a certificate PDF verifier.
- The current audit harness claims individual `run_id` + `case_id` pairs. It does not persist a completed suite result that can authorize certificate issuance.
- The current `package.json` does not include `pdf-lib` and there is no package lockfile in this repository.
- No PAdES signing certificate, private-key/HSM integration, RFC 3161 TSA integration, or certificate-specific OTS confirmation service has been verified.

## Required backend design before enabling POST /v1/certificate/issue

1. Persist a server-generated audit run record with immutable run ID, suite/version, target commit, start/end timestamps, test inventory, per-test outcomes, and a final signed/authorized success state. The client must never be able to self-assert success.
2. Define issuance authorization: authenticated issuer role, tenant binding from verified identity, replay protection, idempotency key, and strict request/body limits.
3. Generate a deterministic certificate manifest from the approved run. The manifest must define the canonical PDF digest semantics and avoid the impossible self-referential claim of embedding the hash of the final PDF inside that same final PDF.
4. Generate the PDF using a pinned, reviewed dependency. `pdf-lib` alone does not create a standards-compliant PAdES signature.
5. Integrate a real signing service or HSM-backed key with a valid signing certificate and produce an embedded PAdES signature. Do not expose private keys in Worker variables or Shopify.
6. Apply an RFC 3161 trusted timestamp if required by the chosen PAdES profile.
7. Compute the digest of the final signed PDF, then create/upgrade an OpenTimestamps proof for that exact digest. Do not claim Bitcoin anchoring until a verifier confirms a Bitcoin block.
8. Store PDF, manifest, detached OTS receipt, and signature-validation evidence in the staging R2 bucket using immutable/content-addressed keys.
9. Return a short-lived download URL only after all required issuance gates pass. Do not expose permanent public R2 object URLs.
10. Implement a certificate verification endpoint that checks PDF digest, embedded signature/certificate chain/revocation, manifest binding, and OTS proof against Bitcoin headers. It must fail closed on missing services, pending proofs, stale/revoked keys, or mismatches.

## Required Shopify integration

- Configure a Shopify App Proxy for the chosen store and route it to a server-side backend.
- The App Proxy must authenticate the Shopify request and securely call the staging Worker; never put `AUDIT_SECRET`, Cloudflare API tokens, R2 credentials, or signing keys in Liquid/JavaScript.
- Replace the demo progress simulation with polling or server-sent progress from a real ARP-100 orchestration endpoint.
- The download button must only appear for a server-confirmed successful run; a client-side progress bar is not evidence.

## Safety / release boundary

- This branch is not deployed.
- No production Worker, `main`, Cloudflare binding, secret, R2 bucket, Shopify live theme, or production configuration was changed.
- Do not merge or deploy until staging CI, negative tests, PAdES validation, OTS/Bitcoin confirmation, App Proxy authentication, and an independent review pass.

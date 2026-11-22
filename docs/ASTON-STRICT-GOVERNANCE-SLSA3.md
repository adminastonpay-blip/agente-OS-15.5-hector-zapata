# ASTON OS — Strict Security Governance and SLSA Build Level 3 Readiness

**Status:** governance baseline / implementation gate; not a certification.
**Repository reviewed:** `adminastonpay-blip/agente-OS-15.5-hector-zapata`
**Default branch:** `main`
**Review date:** 2026-11-22

## 1. Executive decision

ASTON adopts a deny-by-default, evidence-driven security governance model. A release is blocked when identity, authorization, provenance, dependency, license, test, or approval evidence is missing or invalid.

This document does **not** claim SLSA Build Level 3 is already achieved. Repository evidence explicitly marks SLSA provenance as absent, and GitHub's documented Build L3 path requires a vetted reusable build workflow that isolates build steps from the calling workflow. The trusted reusable build platform must be established and independently reviewed before the L3 claim is enabled.

## 2. Verified repository facts

- Repository metadata currently reports **public** visibility and `main` as default branch. This conflicts with the older `standards/LICENSES.md` statement that the repository is private; update publication and legal records to reflect the actual state.
- Root `LICENSE` was not found. The repository-wide software license is therefore not evidenced by the checked root path; do not infer Apache-2.0 coverage.
- `standards/LICENSES.md` describes only a proposed, limited licensing model: ASTON Risk Protocol specification text intended for CC BY 4.0 and selected future interface/schema files potentially under Apache-2.0 after separate notices and ownership review. It expressly excludes implementation code, marks, patents and third-party components.
- `package.json` declares TypeScript, Wrangler and Cloudflare Workers types as development dependencies. A root package lockfile was not found in the inspected paths/search results; reproducible dependency installation must be established before release.
- Code search found use of the Web Crypto API (`crypto.subtle`) for SHA-256, HMAC and signatures. No OpenSSL package, native OpenSSL binding or OpenSSL license notice was found in the repository search. Cloudflare Workers runtime crypto is not the same thing as bundling or licensing OpenSSL.
- Existing controls include Dependabot, Gitleaks, npm audit (moderate+ threshold), Scorecard, TypeScript/security tests and Wrangler dry-runs.
- Existing MVSP assessment and threat model explicitly record SLSA provenance, SBOM, independent penetration testing, access review, legal/privacy evidence and disaster-recovery proof as outstanding or partial.

## 3. Mandatory governance rules

### Source control and approvals
1. All changes to `main` and release tags go through pull requests.
2. Require at least two independent approvals for production/security-sensitive changes where repository plan and team size permit; one approval is the absolute minimum for routine changes.
3. Require CODEOWNERS review for `.github/workflows/**`, `wrangler*.toml`, `src/security/**`, `src/auth/**`, `migrations/**`, licensing files and release manifests.
4. Dismiss stale approvals after new commits; require conversation resolution and required CI checks.
5. Block force-pushes and branch deletion on protected branches/tags. No administrator bypass for routine release operations; emergency bypass must be recorded with reason, actor and retrospective review.
6. Require verified signed commits and signed release tags once maintainer signing keys and recovery procedures are established.
7. Separate author, reviewer, release approver and production deployer duties. No self-approval of one's own high-impact change.

### CI and workflow hardening
1. Set workflow-wide permissions to `contents: read`; grant write permissions only to the single job that needs them.
2. Pin third-party Actions to verified full commit SHAs; audit the action source and transitive dependencies before changing pins.
3. Use ephemeral GitHub-hosted runners; do not use persistent self-hosted runners for untrusted PRs.
4. Use `npm ci` with a committed, reviewed lockfile; prohibit lifecycle scripts during dependency acquisition unless explicitly required and reviewed.
5. Run type checks, unit/integration/security tests, secret scans, dependency audit, static analysis, license policy checks and SBOM generation on release candidates.
6. Treat untrusted PR code as untrusted: do not expose secrets, write tokens, production credentials, deployment environments or privileged reusable-workflow permissions to fork/PR jobs.
7. Use environment protection and explicit human approval for release signing and deployment.
8. Do not use mutable action tags for ordinary third-party actions; use verified SHA pins and automated pin-update review.
9. Fail closed if a mandatory security job is skipped, missing, stale or inconclusive.

### SLSA Build Level 3
To claim SLSA Build L3, all of the following are required:
1. A dedicated trusted reusable workflow in a separately governed repository, pinned by immutable commit SHA from the caller and protected by independent CODEOWNERS/review rules.
2. Build steps execute only in that vetted reusable workflow on ephemeral hosted infrastructure; the caller workflow cannot inject arbitrary build steps or access signing material.
3. The platform provides unforgeable provenance, isolation between concurrent builds and no persistence between runs; provenance signing material is inaccessible to user-controlled build steps.
4. Build inputs, source commit, workflow identity, builder identity, dependencies and artifact SHA-256 digests are captured in SLSA provenance v1.
5. Generate an SPDX or CycloneDX SBOM from the exact locked dependency graph and bind it to the release artifact with an attestation.
6. Publish provenance and SBOM alongside every release artifact; retain verification instructions and verify before deployment/consumption.
7. A policy verifier rejects artifacts unless the signature, issuer, repository, trusted reusable workflow, source ref, commit, digest and SLSA predicate/level all match the release policy.
8. Validate the complete chain on a test release and retain CI logs, attestation bundle, SBOM, digest manifest and verification result.

**Important:** GitHub artifact attestations alone provide Build L2. GitHub's documented path to Build L3 requires a reusable workflow that isolates the build. ASTON must not label the current pipeline SLSA L3 until the separate trusted workflow and all verification evidence exist.

### Dependency, cryptography and license governance
1. Maintain a generated SBOM for every release and a dependency inventory for runtime and development packages.
2. Block release on known critical/high vulnerabilities unless a documented, time-bounded risk exception is approved by security owner.
3. Review transitive dependencies, package provenance, maintainer health, typosquatting risk, install scripts and abandoned packages.
4. Use the Cloudflare Workers Web Crypto API where appropriate; do not add OpenSSL solely for branding or an assumed security upgrade.
5. If OpenSSL is later introduced, record exact version, source, build configuration, license text, copyright notices, security advisories and patch owner. OpenSSL 3.x uses Apache-2.0; older OpenSSL releases may carry different licensing terms. Do not conflate OpenSSL's license with ASTON's license.
6. Do not adopt a repository-wide Apache-2.0 license without explicit owner/legal approval and a complete provenance/ownership review of all source and contributions.
7. Add a root license only after the owner decides the intended grant, exclusions, patent terms, contributor rights and treatment of third-party material. Until then, state accurately that repository-wide licensing is unresolved.
8. Keep ASTON trademarks, trade secrets, confidential information and implementation code outside any limited specification/interface license unless the rights holder explicitly grants otherwise.

## 4. Security architecture gates

- Identity: phishing-resistant MFA/passkeys for repository, email, Shopify, cloud and domain administrators; unique accounts; recovery controls; quarterly access reviews.
- Authorization: default deny, per-route authorization, tenant isolation from verified identity, no trust in caller-supplied tenant/role/plan fields.
- Secrets: managed secret storage only; no secrets in source, theme JavaScript, artifacts, issue comments or logs; rotate any confirmed exposure and review history.
- Cryptography: use maintained platform primitives, explicit algorithm choices, key separation, rotation and constant-time comparisons where applicable. No custom cryptographic protocol without expert review.
- Runtime: bounded input sizes, concurrency, retries, execution time and spend; rate limits; replay protection; signed webhooks; idempotency.
- Audit: append-only event records plus independent retention/anchoring; separate admin duties; alert on privilege, secret, deployment and policy changes.
- Recovery: tested backups, restore exercises, documented RPO/RTO and incident tabletop.
- External assurance: independent penetration test and remediation evidence before any high-assurance marketing claim.

## 5. Release-blocking gaps at review time

| Gap | Current evidence | Required closure |
|---|---|---|
| SLSA L3 trusted builder | Not evidenced | Separate reusable build platform + signed provenance verification |
| SBOM attestation | Not evidenced | SPDX/CycloneDX release SBOM + signed attestation |
| Root software license | No root LICENSE found | Owner/legal decision and complete ownership review |
| OpenSSL | No repository usage found | Do not claim OpenSSL protection; document only if actually introduced |
| Lockfile/reproducible install | package-lock not found in inspected results | Commit lockfile and require `npm ci` |
| CODEOWNERS | Not found at root | Add owners and protect security-critical paths |
| Branch rulesets | Not inspected/configured by this change | Configure and verify in GitHub repository settings |
| Independent security test | No report evidenced | Commission scoped external test and track findings |
| Access reviews | Not evidenced | Verify owners, collaborators, MFA and app tokens quarterly |
| Legal applicability | Drafts and self-assessment only | Counsel-reviewed country/sector matrix and contract suite |

## 6. Legal and evidence discipline

- No technical control guarantees immunity from lawsuits, regulatory action, subpoenas or mandatory consumer/data rights in every jurisdiction.
- Contract terms cannot waive non-waivable statutory rights or bind courts that lack jurisdictional consent.
- Maintain a jurisdiction-by-jurisdiction matrix for actual markets, controller/processor roles, lawful bases, retention, transfers, subprocessors, breach notices, consumer rights, AI disclosures, taxes and sector obligations.
- Preserve evidence of security controls, approvals, incidents, notices, data requests, vendor due diligence and remediation.
- Obtain qualified local counsel review before publishing legal terms or claiming compliance.
- Never claim SOC 2, ISO 27001, PCI DSS service-provider status, FedRAMP, DoD authorization or SLSA L3 without current, scoped evidence.

## 7. Acceptance and change control

This baseline becomes operational only after the required repository rules, trusted reusable build workflow, release attestations, verification gate, SBOM, lockfile and owner/legal decisions are implemented and tested. Any exception must include: risk, scope, compensating control, accountable owner, approval date and expiry date.

No production deployment, Cloudflare resource/configuration/secret/DNS change, Shopify publication, checkout activation or application permission revocation is authorized by this document.

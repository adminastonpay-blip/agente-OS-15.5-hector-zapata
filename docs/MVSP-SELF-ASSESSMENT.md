# ASTON OS — MVSP v2.0 self-assessment

**Assessment date:** 2026-11-10  
**Branch:** `feat/mvsp-security-hardening-21x`  
**Baseline:** MVSP v2.0-20221012  
**Type:** Repository/code evidence review; not an audit, certification, penetration test, or legal opinion.

Status definitions: **Partial** = some evidence exists but required proof remains; **Gap** = no sufficient evidence; **N/A (provider delegated)** = primarily operated by the hosting provider, with provider assurance still required; **Implemented / pending CI** = code added in this branch but full CI not yet verified.

## 1. Business controls

| ID | Control | Status | Evidence / remaining work |
|---|---|---|---|
| 1.1 | External vulnerability reports | Partial | SECURITY.md and security.txt added. Public reporting access, named contact, and explicit safe-harbor terms need owner confirmation. |
| 1.2 | Customer testing | Partial | Isolated staging config and synthetic-data runbook exist. Customer test-request process and authorized testing terms are not evidenced. |
| 1.3 | Self-assessment | Partial | This versioned assessment added; owner approval and annual review cadence remain outstanding. |
| 1.4 | External testing | Gap | No independent annual penetration-test report or engagement evidence found. |
| 1.5 | Training | Gap | Role-specific training records are not present. |
| 1.6 | Compliance | Gap | Legal, privacy, data-localization, and sector requirements need counsel/product-owner assessment. No certification claimed. |
| 1.7 | Incident handling | Partial | Incident runbook added. Named responders, customer/legal contacts, and a rehearsed exercise remain outstanding. |
| 1.8 | Data handling / sanitization | N/A (provider delegated) | Cloudflare manages underlying facilities/media; confirm provider assurance and customer-managed export/backup deletion procedures. |

## 2. Application design controls

| ID | Control | Status | Evidence / remaining work |
|---|---|---|---|
| 2.1 | Single Sign-On | Partial | Cloudflare Access JWT verification hardened in this branch. Customer SSO and MFA configuration are not verified. |
| 2.2 | HTTPS-only | Partial | Cloudflare edge TLS is intended and HSTS added to JSON responses. HTTP redirect and external TLS scan evidence remain outstanding. |
| 2.3 | Security headers | Partial | JSON responses set CSP, frame, MIME-sniffing, referrer, cache, and HSTS headers. Binary audio/SSE need equivalent review and tests. |
| 2.4 | Password policy | N/A (delegated) | Worker does not implement password storage/reset; authentication delegated to Cloudflare Access or API credentials. |
| 2.5 | Security libraries | Partial | Cloudflare platform APIs and parameterized D1 queries are used. Full input/output and dependency review remains. |
| 2.6 | Dependency patching | Partial | Dependabot and npm audit exist. Audit threshold must block medium+ advisories and patch-time evidence must be tracked. |
| 2.7 | Logging | Partial | D1/R2 audit and lineage paths exist. Full auth/CRUD/admin-access logging, IP, 30-day retention, and sensitive-payload exclusion are not demonstrated. |
| 2.8 | Encryption | Partial | Cloudflare edge TLS is intended. At-rest encryption, backup encryption, key ownership, and contractual evidence need verification. |

## 3. Application implementation controls

| ID | Control | Status | Evidence / remaining work |
|---|---|---|---|
| 3.1 | List of data | Partial | DATA-INVENTORY.md added; owner must confirm actual classes, retention, regions, and regulated-data scope. |
| 3.2 | Data flow diagram | Partial | THREAT-MODEL.md includes a logical flow; validate against deployed bindings and integrations. |
| 3.3 | Vulnerability prevention | Partial | Central API access boundary, trusted tenant/plan claims, JWT validation, and regression tests added. Full prompt-injection, CSRF, injection, session, and cross-tenant tests remain. |
| 3.4 | Time to fix vulnerabilities | Partial | 90-day target documented; no measured remediation history or issue-tracker evidence available. |
| 3.5 | Build and release process | Partial | GitHub Actions, type checks, Wrangler dry-runs, secret and dependency scans exist. SLSA provenance/attestation is not evidenced. |

## 4. Operational controls

| ID | Control | Status | Evidence / remaining work |
|---|---|---|---|
| 4.1 | Physical access | N/A (provider delegated) | Obtain current Cloudflare assurance reports for services and regions in use. |
| 4.2 | Logical access | Partial | API roles and Access JWT support exist; this branch blocks anonymous private reads and non-privileged writes. MFA, access reviews, account lifecycle, and production permissions need evidence. |
| 4.3 | Sub-processors | Gap | Verified list of providers with customer-data access and annual assessment records not present. |
| 4.4 | Backup and disaster recovery | Partial | Cloudflare storage/journal components exist. Backup destinations, schedules, restore tests, RPO/RTO, and annual exercise are unverified. |

## Changes introduced by this branch

- Anonymous identities no longer accept caller-supplied tenant headers.
- Plan tier derives from verified identity claims/server-side roles, not `X-Aston-Plan`.
- Access JWT verification requires RS256, configured team domain and audience, valid exp/nbf, exact audience membership, and signature verification.
- API-key actor labels use a one-way fingerprint rather than the first eight key characters.
- Central API boundary explicitly allowlists public routes, requires identity for private reads, and admin/executor for other writes.
- JSON responses receive baseline security headers.
- Placeholder account validation no longer reports arbitrary account IDs as valid.
- Regression tests cover access boundaries and tenant/plan spoofing.

## Phase 3 evidence — Zero Trust audit assurance

- SafetyInterlock now appends agent policy decisions and human approval outcomes to tenant-scoped SHA-256 hash chains.
- SQLite triggers reject UPDATE/DELETE against audit events; a unique tenant/previous-hash key prevents chain forks.
- An internal Durable Object verification endpoint checks each tenant chain; automated tests cover intact chains, altered records, broken links, and tenant separation.
- This is repository/code evidence only. It does not provide external WORM storage, independent key custody, retention guarantees, or protection against a privileged operator replacing the entire Durable Object database.

## Release decision

**Not MVSP-conformant yet.** This is a gap-tracked baseline awaiting CI and account-level evidence. External penetration testing, business controls, provider evidence, MFA/access reviews, SLSA provenance, full logging/retention, and disaster-recovery testing remain open. Do not present this as a customer security certification.

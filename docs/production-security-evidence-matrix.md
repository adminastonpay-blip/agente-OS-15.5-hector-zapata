# ASTON OS — Production Security and Release Evidence Matrix

**Status:** Evidence register; all controls start as NOT VERIFIED. A written policy is not proof of implementation.

| Control | Required evidence / test | Owner | Status |
|---|---|---|---|
| Authentication | Tests for login/session lifecycle, expiry, revocation, MFA where required | Engineering | NOT VERIFIED |
| Authorization / RBAC | Positive and negative tests for every role and sensitive route | Engineering | NOT VERIFIED |
| Default deny | Unauthenticated, unauthorized, unknown-role and missing-policy requests denied | Engineering | NOT VERIFIED |
| Tenant isolation | Cross-tenant read/write/API/object access tests; no data leakage | Engineering | NOT VERIFIED |
| Input validation | Schema validation, bounds, encoding and malformed payload tests | Engineering | NOT VERIFIED |
| Secrets | No secrets in repo, logs, client bundles or error responses; rotation proof | Security | NOT VERIFIED |
| Audit trail | Actor, action, target, timestamp, outcome; tamper/access controls | Security | NOT VERIFIED |
| Rate limiting / abuse | Burst, enumeration, replay and resource-exhaustion tests | Engineering | NOT VERIFIED |
| Dependency security | Lockfile review, vulnerability scan, upgrade plan | Engineering | NOT VERIFIED |
| D1 data access | Least privilege, parameterized queries, backup/restore evidence | Engineering | NOT VERIFIED |
| Worker configuration | Environment separation, bindings, routes, secrets and deployment review | Platform | NOT VERIFIED |
| Incident response | Tabletop exercise, contacts, credential revocation and recovery drill | Security | NOT VERIFIED |
| Privacy | Data inventory reconciled with code, vendors and published notice | Privacy | NOT VERIFIED |
| Logging/retention | Redaction of secrets/PII, retention policy and deletion evidence | Security | NOT VERIFIED |
| Shopify storefront | CTA/link/form tests, legal links, consent, mobile/keyboard/accessibility | Web | NOT VERIFIED |
| Checkout | Approved price/tax/currency, test payment/refund and receipt | Commercial | BLOCKED |
| Recovery | Rollback and backup restore tested, with recorded timings | Platform | NOT VERIFIED |

## Evidence rules
1. Record test date, environment, commit/deployment ID, command or procedure, expected result, actual result and reviewer.
2. Attach CI logs or redacted evidence; never attach credentials, customer data or raw secrets.
3. A passing unit test does not replace integration, authorization, tenant-isolation or operational tests.
4. Mark PASS only when reproducible evidence exists. Otherwise use FAIL, BLOCKED or NOT VERIFIED.
5. Re-run relevant tests after security-sensitive code/configuration changes.

## Release decision
Production release requires all critical security/privacy controls PASS, commercial/legal blockers resolved, named owner approvals and an explicit launch authorization. Until then, keep the candidate unpublished and checkout inactive.

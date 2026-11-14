# Enterprise Diagnostic Attestation

**Status:** IMPLEMENTED (code path) · not PRODUCTION until email + R2 + independent verify are proven  
**Branch:** `feat/ai-surface-scanner`  
**Related:** ATI 2.0, aston-attestation-sdk, ARP-1, OpenSSF Best Practices project 16476 (ATI)

## Goal

Deliver a **passive, authorized domain diagnostic** without exposing findings in the browser.

```text
Shopify (target URL + corporate email)
    → POST /v1/audit
    → Passive public fetch + header/secret-pattern checks (edge)
    → Evidence package (claims + digests, no raw secrets)
    → HMAC-SHA256 signature (PII_HMAC_SECRET or API_KEY)
    → Store package in R2 (JOURNAL or AUDIT_ARCHIVE)
    → Queue / send private email (when mail provider configured)
    → Browser receives only: ok, request_id, delivery, attestation_status
```

## Public response contract (browser)

```json
{
  "ok": true,
  "request_id": "req_…",
  "delivery": "email_queued" | "stored_only" | "email_skipped_no_provider",
  "attestation_status": "unverified"
}
```

- **Never** return `score`, `vulnerabilities`, or full AI report to the browser on `/v1/audit`.
- `attestation_status` stays `unverified` until an independent verifier (policy + optional OTS) marks otherwise.

## Legacy path

`POST /api/scan` remains the **interactive** surface scanner and may still return score/findings for lab use. Prefer `/v1/audit` for enterprise demos.

## Maturity levels

| Level | Criteria |
|-------|----------|
| **IMPLEMENTED** | `/v1/audit` accepts target+email, builds package, signs when secret present, stores when R2 bound, returns minimal JSON |
| **VALIDATED** | Staging tests: email↔domain match, rate limit, package HMAC verify, no findings in response body |
| **PRODUCTION** | Real email delivery, R2 retention, OTS optional via aston-ots-verifier, runbook, main protection, monitored |

## Trust claims (honest)

- OpenSSF badge on **aston-trust-infrastructure** (project 16476) is project Best Practices self-assessment — **not** a certification of the customer domain scanned.
- A signed evidence package proves **integrity of the recorded package**, not that every claim about the target is true.
- OTS `confirmed` requires independent Bitcoin verification; `pending` must not be marketed as confirmed.

## Secrets / bindings

| Name | Role |
|------|------|
| `PII_HMAC_SECRET` or `API_KEY` | HMAC for evidence package |
| `JOURNAL` or `AUDIT_ARCHIVE` | R2 storage |
| Mail provider (future) | Actual SMTP/API send |

## Shopify

Section: `shopify/sections/aston-scanner-dashboard.liquid`  
Success copy must show `request_id` and attestation **unverified** until independent control.

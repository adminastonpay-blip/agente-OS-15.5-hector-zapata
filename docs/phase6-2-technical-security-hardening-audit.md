# Phase 6.2 — Technical Security Hardening Audit

**Status:** source-level audit in progress. This document records verified code observations, not a penetration-test result or compliance certification.
**Scope:** default-branch source inspected on 2026-11-22. No production resources or customer data accessed.

## Executive summary

The current source contains useful security controls (request guard imports, credential-output guard, server-side chat authorization, staging audit body bounds, and a staging route allowlist). However, the inspected code also exposes release-blocking questions that must be resolved before production approval.

## Verified source observations

| ID | Severity | Observation | Evidence | Required action |
|---|---|---|---|---|
| AST-62-01 | High / review required | The Worker defines `Access-Control-Allow-Origin: *` globally while allowing Authorization and tenant/payment-related request headers. | `src/index.ts`, `CORS` constant | Replace wildcard with an explicit environment-specific origin policy; reject unapproved origins and test preflight/credential behavior. If endpoints are intentionally public, document the exact threat model and separate those routes. |
| AST-62-02 | Medium | The built-in chat system prompt and several API validation errors are Spanish, while the public web requirement is English-first. | `src/index.ts`, `SYSTEM_CHAT`, request error strings | Inventory all public/customer-facing strings and localize API/UI copy to English by default. Keep locale-specific legal disclosures where required. Do not rewrite user-generated content. |
| AST-62-03 | High / staging boundary | The staging allowlist includes ETL ingest and RAG ingest/query in addition to health/audit routes. | `src/audit/staging-route-guard.ts` | Treat this Worker as integration staging, not audit-only. If audit-only isolation is required, use a separate config/Worker and allow only health/audit paths. |
| AST-62-04 | High / configuration | The staging Wrangler config binds a preview queue, D1 staging database, Vectorize index and AI, contrary to any audit-only description. | `wrangler.staging.toml` | Reconcile runbooks and configuration; verify resource ownership/isolation and ensure no production/shared customer data is used. Do not deploy until the boundary is approved. |
| AST-62-05 | Medium | The staging audit wrapper disables several data bindings for its internal chat call, but the outer Worker still exposes separately allowed ETL/RAG routes. | `src/audit/staging-endpoint.ts`, `src/audit/staging-route-guard.ts` | Test every exposed route independently; do not infer whole-Worker isolation from the audit wrapper's inner environment clone. |
| AST-62-06 | Medium | TTS binary responses construct headers separately from the shared JSON response helper and do not visibly inherit the complete security-header set. | `src/index.ts`, `handleTts` | Apply a common hardened response-header helper to binary and JSON paths; test HSTS, nosniff, no-store, referrer and framing policy where applicable. |
| AST-62-07 | Release blocker until tested | The top-level source imports rate-limit and request-body guard helpers, but this source review alone does not establish that every route/method/body path invokes them before parsing or side effects. | `src/index.ts` imports and route dispatch require full-path review | Build a route/method matrix and verify guard placement with tests for malformed, oversized, unauthenticated and rate-limited requests. |

## Controls observed (not certification)

- Chat requests resolve identity and pass through `ControlGate.authorizeChat` before model execution.
- Chat output is checked by a credential-pattern guard before returning the answer.
- Chat streaming is disabled pending a buffered safety guard.
- Staging audit requests enforce a bounded body, schema validation, an audit token, and a one-model-call budget.
- The audit chat invocation removes SESSION, D1, queue, R2/journal, Vectorize and Hyperdrive bindings from that inner call.

These observations do not prove that every route is protected or that controls are correctly configured in deployed environments.

## Phase 6.2 verification plan

1. Complete route inventory from `src/index.ts` and all route modules, including HTTP methods and side effects.
2. Verify authn/authz and tenant isolation on every protected route; prove default-deny behavior with negative tests.
3. Implement and test explicit CORS allowlists per environment.
4. Apply shared security headers consistently to JSON, audio/binary, error and OPTIONS responses.
5. Verify request-size, rate-limit and content-type enforcement before body parsing or downstream work.
6. Reconcile audit-only versus integration-staging documentation/configuration and isolate resources.
7. Run the repository's actual typecheck, safety/security test scripts, AI guardrail check, dependency audit, secret scan and Wrangler dry-run in an isolated environment; attach raw results.
8. Add English-first public-string checks to CI, with reviewed exceptions for required local-language disclosures.
9. Record each control as VERIFIED, PARTIALLY VERIFIED, NOT VERIFIED, NOT APPLICABLE (with rationale), or BLOCKED. A source inspection is not runtime evidence.

## Release decision

**BLOCKED — no production release approval.** CORS policy, staging boundary, full route guard coverage, deployed-resource isolation, and test evidence remain open. No deployment, migration, secret change, Shopify publication, payment activation or production data operation was performed for this audit.

## Limitations

This is a focused source inspection of selected files on the repository default branch. It is not a full code review, live configuration audit, penetration test, legal opinion, SOC 2 report, ISO certification or proof of compliance with all laws. Applicable obligations must be assessed against actual products, data flows, customer locations and entity records.

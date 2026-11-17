# Adversarial Pass 1 — Execution Trace Report

**Base:** `main` snapshot `077331484f0cbfae4a23139564000117510a6767` (unpatched).  
**Branch:** `test/adversarial-pass-1`.  
**Application source modified:** no.  
**Execution status:** tests authored; GitHub Actions run not yet inspected. No result is claimed until CI logs are available.

## Route and fixture boundary

The current tests invoke the actual `AgentNode.fetch(POST /execute)` route and exercise its real planning/tool/synthesis gate sequence. Only model planning, tool adapter and synthesis are replaced with synthetic deterministic adapters. The SafetyInterlock Durable Object is currently a synthetic stub, so policy IDs/effects in traces are fixture policies. This is not yet a full production-policy trace and cannot validate the DO policy engine.

Each test emits Node test diagnostics containing tenant, actor, tool, fixture policy ID/version/effect where applicable, response class, state/route branch, route status and plan/tool/synthesis invocation counters.

## Execution-order matrix

| ID | Scenario | Expected | Observed | Trace source | Verdict |
|---|---|---|---|---|---|
| UNAV-01 | Missing DO binding | Deny before planning/tool | Not run | Route response + counters; policy evaluation not reached | NOT RUN |
| UNAV-02 | DO fetch throws (timeout/exception fixture) | Deny tool call | Not run | Request context + fixture allow on plan + thrown fetch + counters | NOT RUN |
| UNAV-03 | Tool decision delayed beyond 40 ms | Bounded fail-closed; late allow cannot revive | Not run | Deadline observation + late response + tool counter | NOT RUN; source currently has no explicit deadline |
| UNAV-04 | Empty 204 response | Deny; no tool | Not run | Empty response/JSON failure + route/counters | NOT RUN |
| UNAV-05 | Contract version 99 | Deny; no tool | Not run | Fixture policy/version + route/counters | NOT RUN |
| STATUS-01 | HTTP 200 with unknown status | Deny; no tool | Not run | Fixture policy/effect + route/counters | NOT RUN |
| STATUS-02 | Explicit supported allow | Tool runs exactly once | Not run | Positive-control policy + route/counters | NOT RUN |

## AUTHZ-REQAPP-001 — not yet implemented

| ID | Scenario | Expected | Observed | Trace | Verdict |
|---|---|---|---|---|---|
| AUTHZ-01 | Sensitive read with require_approval | Block sensitive data until matching approval | Not implemented | No routed D1/policy trace harness yet | BLOCKED BY FIXTURE |
| AUTHZ-02 | Operational read with allow | Operational data succeeds | Not implemented | Paired positive control absent | BLOCKED BY FIXTURE |

Both cases must be implemented as a pair. Blocking every read is not acceptable.

## Tenant tests — three distinct cases, not yet implemented

| ID | Scenario | Expected | Observed | Trace | Verdict |
|---|---|---|---|---|---|
| TEN-01 | Tenant A top-level; nested resource resolves to tenant B | Reject nested reference | Not implemented | Need actual nested resource resolver + DB fixture | BLOCKED BY FIXTURE |
| TEN-02 | Valid token for previous or archived tenant | Reject stale/archived context | Not implemented | Need signed JWT fixture + tenant lifecycle lookup | BLOCKED BY FIXTURE |
| TEN-03 | Same resource ID exists under two tenants | Resolve by tenant + resource composite key only | Not implemented | Need actual resource route + collision fixture | BLOCKED BY FIXTURE |

Changing only tenant_id in a URL is not a substitute.

## Interpretation limits

- A failing assertion is not a confirmed vulnerability unless its trace proves the protected operation was reached and bypassed the intended decision.
- A passing test is not a validated control unless it proves the real route reached the intended policy and state transition.
- The synthetic DO stub means current tests characterize AgentNode routing, not the production SafetyInterlock policy evaluator.
- The delayed-response test must show an application-enforced deadline. The test runner's own deadline is not an application timeout.

## Closure requirements

Record for every case: workflow URL, exact commit SHA, command, exit status, complete diagnostic trace, policy/context, state-machine branch, side-effect counter, expected/observed result, positive control and verdict. No finding is confirmed without the trace. No merge, production, Cloudflare, secret or release changes are authorized.

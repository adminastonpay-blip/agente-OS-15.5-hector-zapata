# Runtime Constitution Route and Enforcement Review

**Status:** SECURITY AUDIT — SOURCE REVIEW + TEST UPDATE  
**Date:** 2026-11-17  
**Repository:** agente-OS-15.5-hector-zapata  
**Production execution:** NOT PERFORMED  
**Cloudflare deployment/runtime validation:** NOT PERFORMED

## Executive finding

The runtime-side `AgentConstitution` in `src/provenance/constitution.ts` is imported by `src/routes/provenance.ts` and exposed through two HTTP endpoints. The inspected execution-control paths use other mechanisms: `SafetyInterlock.evaluatePolicy()`, `evaluateAccess()`, and risk-envelope gates.

The inspected constitution check endpoint is an advisory calculation, not a demonstrated execution authorization boundary. It accepts a constitution object and usage measurements from the request body, evaluates those supplied values, and returns the result. The inspected handler does not load the previously stored constitution record before checking it, and the execution paths inspected do not call `checkConstitution()`.

This is a source-code finding. It does not establish that the endpoint is exploitable in a deployed environment or that a specific deployment exposes it.

## Evidence

### 1. Constitution implementation and route consumer

- `src/provenance/constitution.ts`, blob SHA `b29c99fae060b479c10030a268af9c2f3d5d97f7`.
  - Exports `DEFAULT_CONSTITUTION`, `buildConstitution()`, and `checkConstitution()`.
  - Default allowed tools are `reason`, `search`, and `graph_query`.
  - Checks tool membership, call/cost/write/time budgets, and risk score.
- `src/routes/provenance.ts` imports `buildConstitution` and `checkConstitution`.
  - `POST /v1/constitution` builds a constitution and attempts to persist it in `agent_constitutions`.
  - `POST /v1/constitution/check` requires `body.constitution`, then passes that request-supplied object and request-supplied usage values to `checkConstitution()`.
  - The check handler does not query `agent_constitutions` by tenant or agent before evaluating.
  - Persistence errors are caught and logged; the route still returns the generated constitution.
- `src/index.ts` dispatches requests through `authorizeApiRequest()` before calling `handleProvenance()`.

### 2. Public status of the check endpoint

- `src/security/mvsp-access.ts` includes `/v1/constitution/check` in `PUBLIC_POST_PATHS`.
- `authorizeApiRequest()` allows POST requests in that set without requiring an authenticated identity.
- The route accepts the constitution object and usage counters from the caller.

Therefore, this endpoint can calculate a verdict for caller-supplied input without proving that the constitution was issued by ASTON, belongs to the caller's tenant/agent, is current, or is the policy used by an execution path. Treat its response as advisory only; it must not be represented as an authoritative permit.

### 3. Separate runtime execution controls

- `src/do/safety-interlock.ts` imports and calls `evaluatePolicy()` from `src/safety/policy.ts` in `evaluateAndGate()`.
- That path returns `allowed`, `denied`, or `pending_approval` and records policy/audit information.
- `src/do/agent-node.ts` checks the SafetyInterlock response contract and only invokes `runTool()` when status is exactly `allowed`.
- `src/agents/governed.ts` uses `evaluateAccess()` and risk-envelope checks, and requires a plan status of `approved` before `executePlan()`.
- The inspected `src/agents/governed.ts`, `src/do/safety-interlock.ts`, `src/do/agent-node.ts`, and `src/index.ts` contain no import/call to `checkConstitution()`.

These controls are separate implementations and must not be assumed to inherit the constitution schema or its limits.

### 4. Test coverage update

The initial audit found no runtime test importing the constitution source module directly. That gap has since been partially addressed:

- PR #27 added `tests/runtime-constitution-source.test.mts`, importing `src/provenance/constitution.ts` directly.
- It covers profile defaults, allowed tools, denied tools, the explicit `reason` exception, each numeric budget/risk threshold, and exact-limit behavior.
- PR #27 was merged at commit `607e407ddfe3feb4cab5ad923b124268d945e62b`.
- GitHub Actions run `44192337492` passed: `test:safety`, `test:security`, TypeScript check, and Wrangler dry-run. This is repository CI evidence, not a live Cloudflare deployment or Durable Object/D1 integration test.
- The test does **not** yet exercise the route trust boundary: forged constitution input, tenant mismatch, revoked/expired/stale constitution, authenticated identity binding, approval evidence, or SafetyInterlock failure.

Cloudflare Workers Builds checks on the PR also reported preview failures for configured Worker names that do not exist on the account. Those failures are not evidence of a successful deployment; no deployment was performed here.

## Findings

### RUNTIME-CONST-01 — Caller-supplied constitution is evaluated without loading the stored record

**Severity:** High if callers or downstream systems treat the response as authoritative; otherwise informational/advisory.

The check route accepts `body.constitution` and usage values directly. It does not load the tenant/agent's stored constitution, validate its provenance, or bind it to the authenticated identity. The endpoint is public by route allowlist. This is incompatible with treating the returned `ok` value as proof of authorization.

### RUNTIME-CONST-02 — Constitution check is not the inspected execution gate

**Severity:** Architecture / assurance gap.

The execution paths inspected rely on SafetyInterlock policy, access policy, and risk envelopes. They do not call `checkConstitution()`. Consequently, the limits in the constitution profile are not shown to constrain those execution paths.

### RUNTIME-CONST-03 — Multiple governance policy models coexist

**Severity:** Architecture / assurance gap.

The runtime contains at least three distinct policy mechanisms: constitution checks, SafetyInterlock policy evaluation, and access/risk-envelope checks. Their precedence, shared versioning, conflict resolution, and conformance relationships are not established by the inspected code.

## Required remediation sequence

1. Decide and document that `/v1/constitution/check` is an advisory calculator unless and until a server-authoritative implementation replaces its trust model.
2. Ensure no caller or execution path treats its caller-supplied `ok` response as an execution permit.
3. Define a canonical governance decision contract that binds authenticated principal, authoritative tenant lifecycle, agent identity, issued constitution version/integrity, delegation, resource/action, budget, risk, approval evidence, and policy version.
4. Select one authoritative enforcement point immediately before side effects; it must fail closed on missing, invalid, stale, revoked, cross-tenant, or unverifiable inputs and require an explicit `allowed` decision before execution.
5. Add route and enforcement tests for forged constitution, cross-tenant access, revoked/expired/stale policy, approval evidence, budget boundaries, and interlock failure. PR #28/#29 now add and CI-test a narrower route contract: advisory metadata for caller-supplied evaluation and HTTP 400 when the constitution is missing. Broader identity, tenant, lifecycle, approval, and execution-binding tests remain open.
6. Keep implementation changes separate and validate with simulated tests before any deployment review.

## Disposition

- Runtime constitution route consumer: **CONFIRMED**.
- Check endpoint is explicitly allowlisted as public: **CONFIRMED**.
- Check endpoint loads stored constitution before evaluation: **NOT OBSERVED**.
- Constitution check is wired into inspected agent execution gates: **NOT OBSERVED**.
- Direct tests of the real constitution source module: **IMPLEMENTED AND CI-TESTED** (PR #27).
- Route advisory contract tests: **IMPLEMENTED AND CI-TESTED** (PR #28; test harness correction PR #29). They assert non-authoritative metadata/warning and rejection of a missing constitution; they do not prove issuer authentication, tenant binding, lifecycle checks, or execution authorization.\n- Broader adversarial route/enforcement and real execution integration tests: **NOT IMPLEMENTED**.
- SafetyInterlock is a separate execution gate in inspected paths: **CONFIRMED**.
- Production exposure or exploitability: **NOT ESTABLISHED**.
- GitHub Actions run `44195082214` and `44195082196` on PR #29: **PASSED**, including `test:safety`, `test:security`, TypeScript checks, shell syntax check, and Wrangler dry-runs for staging/production bundles.\n- Cloudflare deployment/live runtime validation: **NOT PERFORMED**.

This document is audit-only. It changes no executable code, schemas, migrations, workflows, secrets, Cloudflare resources, or deployment configuration.

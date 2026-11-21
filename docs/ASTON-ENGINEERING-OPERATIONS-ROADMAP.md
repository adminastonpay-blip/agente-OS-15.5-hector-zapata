# ASTON Engineering Operations & Commercial Platform Roadmap

**Status:** Working plan / baseline audit  
**Date:** 2026-11-21  
**Branch:** `docs/aston-engineering-operations-roadmap`  
**Scope:** ASTON OS on Cloudflare Workers, internal engineering/operator console, Shopify storefront, connectors, observability, delivery pipeline.

## 1. Baseline verified in connected systems

### Shopify
- Connected store: **Aston OS** (`m1m0d3-ru.myshopify.com`), Basic plan, ARS.
- Three themes found: one MAIN theme, two unpublished copies.
- MAIN theme: **ASTON OS Enterprise Command — Launch Ready**.
- Theme includes many ASTON sections, including `aston-command-center-v06`, `aston-connectors`, `aston-core-dashboard`, enterprise home, integrations, governance, telemetry/observability, trust, security and product/service sections.
- Homepage template includes enterprise home and Command Center v0.6 section.
- `aston-command-center-v06` is explicitly a **concept/demo UI**, states no production connection, and uses placeholder indicators/empty data. Its execution, audit and security panels are not backed by live endpoints.
- `aston-connectors` has a browser UI for Shopify, Mercado Libre, Amazon SP-API, TikTok Shop, Meta Business and Google Merchant Center. It calls a backend contract under `/api/connectors`; live OAuth/token lifecycle and provider-side scopes need validation.
- Existing command-center template references a different Worker endpoint than the currently identified Cloudflare Worker. Endpoint alignment is a first-priority verification.

### Cloudflare
- Authenticated account connection verified.
- One Worker script found: `agente-os-15-5-hector-zapata`.
- Worker has Fetch and Queue handlers and Durable Object exports including AgentNode, GraphResolver, MissionBrain, ReplayGuard, SafetyInterlock, SessionMemory, SimulationTwin, Supervisor; RecoveryWorkflow is also exported.
- SQLite-backed Durable Objects are declared.
- The API list response did not establish end-to-end service health, traffic, latency, error rate, connector status, or deployment readiness. Those require runtime checks and telemetry.
- Logpush is reported as false on the Worker inventory record. Verify Workers Logs/Traces and structured telemetry settings; do not assume this means logs are absent.

### GitHub
- Repository: `adminastonpay-blip/agente-OS-15.5-hector-zapata`.
- TypeScript Worker project; existing CI workflow files include Cloudflare CI, isolated staging deployment, dependency audit, Gitleaks, Scorecard, RAG isolation and audit validation.
- There are 12 open issues at the time of the baseline check. Prior review flagged MCP governance and x402 as areas that may still be incomplete/demo-level; re-audit before describing them as production-ready.

## 2. North-star architecture

**One private engineering/operator control plane; public storefront remains marketing/demo and customer onboarding only.**

```
Engineer / Operator
       |
Identity + MFA + Access policy (private)
       |
ASTON Engineering Console (private UI)
       |
API Gateway / versioned Worker routes
       |
Control Gate ── Policy & Risk ── Approval Queue
       |                |                |
Agent / Mission APIs    Simulation       Human review
       |
Execution adapters / connectors (least privilege, per tenant)
       |
Durable workflows / queues / retry / DLQ
       |
Evidence & audit chain ── Observability / alerts / dashboards
```

Shopify must not host or expose the private engineering console. Use Shopify as the public commercial site, with carefully labeled non-live demos and links to authorized customer/admin experiences.

## 3. Engineering console — proposed navigation

1. **Overview / NOC:** service health, deployment version, environment, error/latency trends, recent incidents; never use mock live-state numbers.
2. **Services & Workers:** Worker inventory, route/endpoint catalog, environment (dev/staging/prod), bindings metadata (names/types only), deployment history, status and rollback instructions.
3. **Agent Runtime:** agent inventory, model/provider, capability scope, execution state, rate/budget limits; sensitive config never displayed.
4. **Missions / Workflows:** queue and workflow state, retries, cancellation, idempotency, stuck-step detection, dead-letter view, replay controls guarded by approval.
5. **Policy & Control Gate:** policy versions, change history, allow/review/deny decisions, risk thresholds, simulation before activation, dual approval for production policy changes.
6. **Approvals:** review queue, full action context, risk rationale, expiration, reviewer identity, approval/denial and immutable audit event.
7. **Connectors:** catalog, authorization state, granted scopes, health test, last successful sync, rate limits, errors, revoke/rotate controls, provider docs, sandbox mode.
8. **Audit & Provenance:** searchable events, correlation/trace ID, tenant filter, hash-chain checks, export, retention policy.
9. **Security & Incidents:** auth anomalies, WAF, rate limiting, secret rotation reminders, kill-switch status, incident runbooks.
10. **Observability:** logs, traces, metrics, SLOs, alert history and links to Cloudflare native views.
11. **Data / Storage:** D1, KV, R2, Durable Objects, Queue, Workflow inventory; migration status, backup/restore checks and retention.
12. **CI/CD & Releases:** Git commit, CI checks, artifact, staged rollout, deployment diff, smoke tests, rollback history.
13. **Developer tools:** API explorer for approved endpoints, feature flags, test fixtures, local/staging environments, runbook search.
14. **Billing / Usage:** per-tenant usage, cost budgets, provider spend, rate/budget alarms, no billing claims until sources are connected.
15. **Settings / Access:** RBAC, groups, session controls, MFA enforcement, environment protections, audit exports.

## 4. Connector framework

### First-wave connector targets
- Cloudflare (platform and deployment/telemetry surfaces)
- GitHub (repositories, CI, issues, release metadata)
- Shopify (store/catalog/order data only with explicit scopes)
- Google Workspace (identity, selected apps and events as scope permits)
- Slack (notifications and approvals, optional)
- Sentry (application errors and traces)
- OpenTelemetry-compatible observability destination
- Stripe (billing/usage, read-only first)
- Microsoft 365 / Teams (enterprise pilot option)

### Connector lifecycle (standard)
- Discovered → not configured → authorization pending → connected → degraded → revoked.
- OAuth uses server-side callback, state+PKCE where provider supports it, strict redirect allowlist, minimum scopes, encrypted secrets, tenant isolation and token rotation.
- “Connected” is only shown after token validation and a real provider health check. Never present a simulated result as live.
- Connector test must be read-only by default; write capabilities are separately permissioned and approval gated.
- Each connector must implement: manifest, scopes, OAuth, token storage, health probe, error mapping, rate-limit handling, webhook validation, sync cursor, idempotency, revocation, audit events, test suite, documentation and owner.

## 5. Cloudflare services — proposed fit, validate plan and limits before enabling

- **Workers:** stateless API, auth callbacks, connector endpoints, public health checks with minimal data.
- **Durable Objects:** per-tenant state, control gate, approval queues, replay protection, coordination and mission state.
- **D1:** relational control-plane records (users/roles, connector metadata, policy versions, approvals, tenant configuration).
- **KV:** cached configuration or low-risk lookup data; never use as sole source for critical audit or transactional approval.
- **R2:** audit export bundles, artifacts, reports, permitted logs and durable evidence.
- **Queues:** decouple sync, notifications, background checks and batch processing; configure retries and DLQ.
- **Workflows:** multi-step recoverable tasks with explicit timeouts, step persistence, retries and compensating actions.
- **Analytics Engine:** custom operational events and usage metrics; query through documented APIs.
- **Workers Logs/Traces + OpenTelemetry:** structured logs, request correlation, sampling and export.
- **Cloudflare Access:** private engineer console authentication and identity policy; require MFA and least privilege.
- **WAF / rate limits / Turnstile:** protect public endpoints and appropriate high-risk surfaces.
- **Secrets:** Cloudflare secrets; secret values never returned to UI or logs.
- **Environments:** isolated dev, staging and prod accounts or resources; production write permissions and secrets not shared with staging.

## 6. Reliability, security and release gates

- [ ] Map every public/internal route and its owner, auth mode, scope and environment.
- [ ] Confirm tenant identity comes from authenticated server-side context, not client input.
- [ ] Fail closed for privileged operations; no implicit allow.
- [ ] Establish threat model and abuse cases for agent/tool actions.
- [ ] Require approval for sensitive/high-impact actions, with expiry and actor attribution.
- [ ] Test replay protection, idempotency, rate limiting, request validation and isolation.
- [ ] Add structured JSON logs with correlation IDs; redact PII, credentials and tokens.
- [ ] Enable Workers Logs/Traces, error grouping, dashboards and monitors; validate sampling/retention.
- [ ] Define SLOs only after collecting baseline telemetry; initial targets are proposals.
- [ ] Add unit, integration, end-to-end, contract and adversarial tests.
- [ ] CI must run lint, typecheck, tests, secret scan, dependency audit, build and staging smoke checks.
- [ ] Deployment: build → staging → migrations → smoke → controlled prod rollout → verify → rollback if required.
- [ ] Backup/restore and recovery drills; test the RecoveryWorkflow rather than assuming it works.
- [ ] No production write or publish until change is reviewed and rollback path is prepared.

## 7. Shopify theme and storefront workstream

### Public storefront
- Audit every section/template and classify: **active**, **duplicate**, **broken**, **needs proof**, **marketing only**, **demo only**, **retire candidate**.
- Normalize global header/footer, navigation, accessibility, mobile breakpoints, SEO, performance, translations, theme settings and design tokens.
- Improve product/service pages and pricing/CTA paths in line with the ASTON commercial pitch.
- Replace disconnected or stale Worker URLs after API contract/health verification.
- Ensure all demo metrics, integrations, capabilities and security claims are clearly labeled and backed by evidence.
- Test every page template at desktop and mobile, keyboard navigation and reduced motion.
- Keep private engineering console and privileged controls off the storefront.
- Work on an unpublished theme copy; review screenshots and test; commit theme edits; publish only after explicit go-live approval.

### Existing section inventory to review
Enterprise home, command-center v0.6, legacy command center, core dashboard, connectors, integrations hub, governance/compliance, security/trust center, telemetry/observability, operations, billing, finance, product/academy and all page-module sections. Prioritize shared shell and the 5–8 high-traffic/important sections before tackling long-tail content.

## 8. Milestones and deliverables

### Phase 0 — baseline & access safety (Days 1–3)
- Inventory repo, Worker deployments, routes, bindings, storage, secrets metadata, CI, Shopify theme/pages.
- Confirm domains, environments and production boundary.
- Deliver: system map, route/connector inventory, risks, evidence-backed status table.

### Phase 1 — stabilization (Days 4–14)
- Fix stale endpoint references, health contract, security headers, request validation, auth and tenant isolation gaps.
- Establish structured logging and correlation IDs; create error/latency dashboards and alert thresholds.
- Deliver: green CI baseline, staging smoke suite, runbooks, incident/rollback plan.

### Phase 2 — engineer console MVP (Days 15–30)
- Private console skeleton with Cloudflare Access, navigation and read-only panels.
- Worker/service inventory, health, deployment version, logs/trace links, incident list.
- Connector registry and status model; no provider secrets exposed.
- Deliver: usable private staging console, documented access model, audit events.

### Phase 3 — connector framework (Days 31–60)
- Implement first 2–3 high-value connectors (Cloudflare, GitHub, Shopify), read-only first.
- OAuth lifecycle, scope display, health probes, sync state, revoke and token rotation.
- Add approval queue and event ledger.
- Deliver: end-to-end connectors in staging with contract tests and isolation checks.

### Phase 4 — operational control plane (Days 61–90)
- Policy versioning, risk decisions, human approvals, workflow observability, safe replay/rollback.
- Simulation and approval for policy changes.
- Deliver: measurable operator workflow, tabletop incident drill and security review.

### Phase 5 — enterprise readiness (Months 4–6)
- Tenant onboarding, RBAC/SSO options, retention, exports, backups, cost budgets.
- Security documentation, architecture package, deployment model, pilot metrics.
- Deliver: 2–5 scoped design-partner pilots (target, not committed), support and product feedback loop.

## 9. Priority board

| Priority | Work | Definition of done |
|---|---|---|
| P0 | Endpoint/domain reconciliation | One authoritative environment map; stale endpoint references removed or marked |
| P0 | Production access & auth review | Console private; MFA; least privilege; no secrets in client |
| P0 | Runtime health/telemetry | Live health checks, logs/traces, alerts verified |
| P1 | Engineering console MVP | Read-only service/deployment/incident views working |
| P1 | Connector registry | Real auth and probes, scope/status/error visibility |
| P1 | Policy + approval UX | Review context, approve/deny, audit and expiration |
| P1 | CI/CD and staging quality gates | Build, tests, scans and smoke checks pass |
| P2 | Workflow operations | Retries, DLQ, stuck tasks, cancellation, replay safeguards |
| P2 | Shopify sections cleanup | Section/template inventory, responsive/accessibility/performance checks |
| P2 | Commercial funnel | Product messaging, proof, demo and qualified lead path |
| P3 | Advanced observability and cost controls | SLO trends, budget alerts, tenant usage, operational insights |

## 10. Definition of “operational”

A module is **operational** only when it has a documented owner, environment, route, authenticated source, passing tests, telemetry, alert/runbook, rollback or recovery path and verified user workflow. UI appearance, a green dot, or a deployed Worker alone does not constitute operational readiness.

## 11. Safety and change-management boundary

- Preserve the current live theme and production Worker until the new version passes staging and rollback checks.
- Do not rotate, overwrite or reveal secrets as part of inspection.
- Do not grant connectors broader scopes than needed.
- No destructive data migrations, provider write actions, payment actions, or storefront publish without a separate reviewed change plan and approval.
- Maintain clear **live / staged / demo / planned** labels in all dashboards.

## 12. Immediate next actions

1. Reconcile the Worker URL used by Shopify with the currently deployed Worker.
2. Build an authoritative endpoint and service catalog from code, Cloudflare, and test results.
3. Create a private engineer console architecture and UI prototype.
4. Establish read-only telemetry and health checks before adding write controls.
5. Add connector framework and start with Cloudflare, GitHub and Shopify.
6. Audit the Shopify sections/templates, then work through an unpublished copy in priority order.
7. Use a release checklist and staged rollout for every production change.

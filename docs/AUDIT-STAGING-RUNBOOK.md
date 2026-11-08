# ASTON OS 21.x — isolated audit staging runbook

## Safety boundary

This config creates a distinct Worker named aston-os-21x-audit-staging.
It disables the public workers.dev hostname, so the intended caller is a Cloudflare Service Binding. It does not edit wrangler.toml, does not bind the production D1 database,
does not bind the production ETL queue, and does not change the production
Worker name or deployment. Durable Object SQLite namespaces are isolated by
the staging Worker service identity.

POST /v1/audit-target is disabled unless AUDIT_ENABLED=true and a staging
deployment profile are present. It requires the AUDIT_SECRET secret (minimum
32 characters), a valid authenticated request, a bounded JSON body, a unique
run/case pair, and SafetyInterlock availability.

The endpoint calls the existing chat handler and separately records a
SafetyInterlock preflight. It explicitly reports that the existing public
chat handler does not currently invoke SafetyInterlock or an output guard.
It does not claim that the preflight protects the chat request.

## Required operator setup

1. Review this branch and run the targeted audit-module TypeScript check from the GitHub Actions workflow. The repository-wide strict check currently reports unrelated pre-existing optional-binding errors in existing modules; those are tracked separately and are not suppressed by this staging PR.
2. Generate a high-entropy secret outside GitHub and store it as a Cloudflare
   secret for this staging Worker only:
   npx wrangler secret put AUDIT_SECRET --config wrangler.staging.toml
3. Verify Cloudflare account, Worker name, AI availability and billing limits.
4. Deploy only the staging config after explicit operator approval:
   npx wrangler deploy --config wrangler.staging.toml
5. Confirm /health reports the staging profile and do not send customer data.
6. Configure Trust Fabric Service Binding only after the staging Worker exists
   and its exact service name has been verified.

## Guardrails

- SafetyInterlock enforces a maximum of 2 audit requests per minute and 10
  per hour, with unique run/case claims retained for 24 hours.
- Each request accepts only a single synthetic payload.message field, capped
  at 4,000 characters; the complete request is capped at 8 KiB.
- Chat uses the existing non-streaming handler, a maximum of one Workers AI invocation per case, and its 512-token default cap. AI Gateway and persistence bindings are disabled for the diagnostic call.
- No agent actions, code execution, external tools, customer D1, production
  queues, or production sessions are invoked by this harness.
- Missing AI, SafetyInterlock, secret, feature flag, or staging profile fails
  closed.
- No deployment, secret creation, binding change, or campaign execution is
  performed by committing these files.

## Known coverage gap

The inspected public chat route currently calls the model directly. The
SafetyInterlock preflight in this harness is a separate diagnostic, not a
substitute for wiring policy, input guard and output guard into the actual
public chat pipeline. The observation reports this gap so the evaluator can
record it as a finding. Full chat-path remediation is a separate reviewed
change.

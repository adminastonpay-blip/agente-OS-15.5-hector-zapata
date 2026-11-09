# ASTON OS 21.x — isolated audit staging runbook

## Safety boundary

This branch defines a separate Worker named `aston-os-21x-audit-staging` in
`wrangler.staging.toml`. It does not modify `wrangler.toml`, the production
Worker name, production D1 database, production ETL queue, production secrets,
routes, or bindings.

The staging Worker has `workers_dev = true` so it can be smoke-tested after
deployment. The staging-only route guard allows only:
- `GET /` and `GET /health` for health/status.
- `POST /v1/audit-target` for the authenticated diagnostic harness.

All other application routes return 404 in this staging profile. Production
routing is unchanged. The audit endpoint also requires the `AUDIT_SECRET`
runtime secret (minimum 32 characters), `AI`, and the isolated
`SafetyInterlock` Durable Object binding. Never commit the secret.

## Required Cloudflare setup

1. Create or select a **new, separate** Worker named
   `aston-os-21x-audit-staging`. Do not connect this branch to the existing
   production Worker.
2. Connect repository
   `adminastonpay-blip/agente-OS-15.5-hector-zapata` and branch
   `feat/audit-staging-harness-21x`.
3. In Workers Builds → Settings → Builds, set the deploy command explicitly to:
   `npx wrangler deploy --config wrangler.staging.toml`
   (or `npm run deploy:staging` if that script is added later). Do not use the
   default `npx wrangler deploy`, because the root `wrangler.toml` names the
   production Worker.
4. In the staging Worker only, add the runtime secret `AUDIT_SECRET` under
   Settings → Variables & Secrets. Use a high-entropy value of at least 32
   characters. Do not put it in GitHub variables, source files, or chat.
5. Confirm the staging Worker has the Workers AI binding `AI`. The staging
   config provisions only the `SafetyInterlock` SQLite Durable Object class.
   It intentionally has no production D1, Queue, R2, Vectorize, Hyperdrive,
   or session bindings.
6. Verify the account, Workers AI availability, and usage/billing limits before
   deployment. The repository dry-run cannot prove account-level resources,
   secret presence, permissions, or service availability.

## Validation and smoke test

GitHub Actions validates the code and both Wrangler configurations with dry
runs. A dry-run does not deploy or provision remote resources.

After the isolated staging Worker is deployed:
1. Open `GET /health` and verify the response reports profile
   `21.6.3-audit-staging`.
2. Send only synthetic test data to `POST /v1/audit-target`, with the
   `x-audit-token` header set to the staging `AUDIT_SECRET`.
3. The request body must use schema version `aston.audit.request.v1`, a
   unique `run_id`, a `test_case_id`, and a single `payload.message` field.
4. Confirm the response reports the policy preflight and the chat observation.
   Do not use customer records, production credentials, or sensitive data.

## Runtime guardrails

- Maximum 2 audit claims per minute and 10 per hour; unique run/case claims
  are retained for 24 hours.
- Request body capped at 8 KiB; message capped at 4,000 characters.
- One Workers AI invocation maximum per audit case.
- The diagnostic chat call disables session persistence, D1, queues, R2,
  Vectorize, Hyperdrive, and AI Gateway.
- No agent actions, code execution, external tools, customer D1, production
  queues, or production sessions are invoked by this harness.
- Missing AI, SafetyInterlock, secret, feature flag, or staging profile fails
  closed.
- Streaming chat is disabled in the staging profile until the full output can
  be checked before tokens are emitted.
- The staging route guard blocks all other application endpoints. Health
  endpoints are read-only; the diagnostic endpoint is secret-protected.

## Coverage limitations

The credential-pattern output guard is a narrow leak guard, not semantic
moderation, prompt-injection detection, or a complete data-loss-prevention
system. The audit harness is a bounded diagnostic of the existing chat path,
not proof of complete security certification. Full Workers-runtime integration
testing and a formal security review remain separate release-hardening tasks.

## Release boundary

No merge, production deployment, production binding change, D1 migration,
secret creation in production, route change, or campaign execution is
authorized by this runbook. A successful GitHub dry-run is not a deployment.
A successful staging deployment is not production approval.

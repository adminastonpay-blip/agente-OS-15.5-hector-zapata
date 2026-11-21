# ASTON Preview Build Failure — Cloudflare 10067

Date: 2026-11-21

## Status

**Read-only diagnosis. No Cloudflare configuration, Worker, Durable Object namespace, binding, secret, database, queue, Vectorize index, or deployment was changed by this investigation.**

The ASTON staging-boundary documentation PR was merged into `main` as merge commit `db0d56074d7008c30ddbcfe9279ac5bed06caf5b`. Its Cloudflare Preview Build did not succeed.

## Verified failure

Cloudflare build `4fb732a4-f2dc-430d-9ca0-cc9281e4967d` (account `70e8821e0eeeccb401d9ba0b3f4dbfe8`) stopped with `build_outcome=fail`.

The build log shows:

- Dependencies installed successfully.
- Cloudflare executed `npx wrangler preview`.
- Wrangler requested a Preview deployment for Worker `agente-os-15-5-hector-zapata`.
- Cloudflare rejected the API request with error **10067**: the account reached the Workers Free limit of 100 Durable Object namespaces.
- The build ended with “Failed: error occurred while running deploy command”.

The failed build record is not a successful Preview deployment. No retry was started during this investigation.

## Build configuration observed

The production Workers Builds configuration is connected to this repository and the `main` branch:

- Production deploy command: `npx wrangler deploy`.
- Production `auto_build_enabled=false`.
- Preview builds are enabled.
- Preview deploy command: `npx wrangler preview`.
- Preview path include: `*`.

A branch-specific Preview trigger was created for `audit/staging-boundary-reconciliation`, with the same `npx wrangler preview` command and root directory `/`. Its build was triggered by a push event. This explains why a documentation-only branch attempted a Preview deployment.

The production build configuration and trigger were only read. They were not changed. The presence of this failed Preview build does not prove that production was deployed or changed.

## Interpretation

This is an account capacity / Preview deployment configuration blocker, not evidence of a TypeScript or application test failure.

The Preview command invokes Wrangler against the repository's root configuration unless explicitly directed otherwise. The root configuration is the production Worker configuration, with Preview overrides. Therefore, a Preview build is not equivalent to the separately specified audit-only staging profile.

The staging runbook and staging Wrangler profile still conflict as documented in `docs/STAGING-BOUNDARY-RECONCILIATION.md`. In particular, the audit-only runbook's no-D1/no-Queue/no-Vectorize boundary is not represented by the current staging config and route allowlist.

## Required corrective decisions

1. Decide whether Cloudflare Preview builds should remain enabled for this Worker. If yes, define a safe Preview strategy that cannot create unapproved Durable Object namespaces or attach shared Preview data resources.
2. If Preview builds are retained, explicitly select a safe config and command; do not assume `npx wrangler preview` is isolated staging.
3. Do not upgrade the Cloudflare plan merely to bypass error 10067. First inventory namespace usage and ownership, then approve any capacity or billing change separately.
4. Keep audit-only staging and integration staging as distinct Workers and resource profiles. Integration staging requires separately approved D1, Queue, and Vectorize resources.
5. Re-run only after the configuration and account-capacity decisions are approved. A successful dry-run is not a deployment, and a successful Preview is not production approval.

## Change boundary

This report is documentation only. It does not change the root Wrangler config, staging Wrangler config, GitHub Actions, Workers Builds settings, application code, migrations, Cloudflare resources, or secrets. No deploy, retry, migration, or plan upgrade is authorized by this report.

# ASTON Shopify — Phase 1 public gateway

## Routes

- `GET /v1/engineering/health`: private read-only D1 probe; requires a verified `admin` or `executor` identity.
- `GET /v1/public/health`: allowlisted Shopify-origin bridge; returns only status, latency and timestamp.
- `POST /v1/public/leads/ciso`: allowlisted, Turnstile-protected intake. Payload is AES-GCM encrypted before D1 insertion; an HMAC email digest supports private deduplication without storing plaintext email.

## Required configuration

- `SHOPIFY_ALLOWED_ORIGINS`: comma-separated exact HTTPS origins. Initial candidate: `https://m1m0d3-ru.myshopify.com`. Add the verified custom storefront origin only after checking the Shopify domain configuration.
- `TURNSTILE_SECRET_KEY`: Cloudflare Turnstile secret, configured as a Worker secret (never a public variable).
- `LEADS_ENCRYPTION_KEY`: base64url-encoded random 32-byte key, configured as a Worker secret. Generate and store out of band; do not commit it.
- `DB`: D1 binding configured in `wrangler.toml`.

The lead route returns 503 until all required bindings/secrets exist. It does not fall back to Shopify contact storage or plaintext writes.

## D1 migration

`migrations-shopify/0001_ciso_leads.sql` creates the encrypted lead table and indexes. It is an isolated SQL artifact only; it is intentionally outside the shared Wrangler migration directory. Apply it with an explicit D1 execute command against the verified database during an approved release, not during PR review. Confirm the Worker `DB` binding points to the intended database before applying.

## Shopify theme wiring

The theme should submit to the public route and include a Turnstile token with action `aston_ciso_lead`. Never call the private engineering route from browser JavaScript and never embed Worker secrets in Liquid or theme settings. The health button must display only the sanitized public response.

## Retention and operations

Rows carry a 180-day expiry timestamp. A scheduled deletion job and a restricted operator read/export path are still required before this is considered a complete operational lead-management system. No leads are read or exposed by these public routes.

## Rollout

1. Review and merge this code.
2. Configure secrets and exact origins.
3. Confirm D1 binding/database identity.
4. Apply migration to the confirmed D1 database.
5. Deploy Worker and verify private/public health routes.
6. Wire and test the unpublished Shopify candidate theme.
7. Publish the theme only after explicit approval.

# ASTON 15.5 — Tenant Fallback Inventory (W1)

**Scope:** read-only inventory from host `main` snapshot `be8c92c017fd2586098b33bed1b16fdeb9214729`.  
**Status:** inventory only; no runtime code changed.

## Confirmed identity fallbacks

- `src/auth.ts`: Cloudflare Access JWT signature, issuer, audience and time checks are performed, but the resulting public Identity discards verified `iss` and `sub`.
- `src/auth.ts`: shared `API_KEY` maps to `tenant: "default"`, roles `admin, executor`.
- `src/auth.ts`: `X-Sensor-Key` reuses `API_KEY`, maps to static actor `lb-sensor`, tenant `ops`, role `sensor`.
- `src/types.ts`: public `Identity` has actor/method/tenant/roles/clearance/plan only; no separate trusted principal.

## Confirmed tenant-default use sites

The following files contain explicit fallback to `identity.tenant || "default"` or equivalent:

- `src/routes/risk.ts` — risk assessment and envelope lookup.
- `src/economy/x402.ts` — economic record persistence.
- `src/routes/infra.ts` — decision artifact persistence.
- `src/lib/sovereign.ts` — Durable Object namespace helper defaults tenant.
- `src/routes/economy.ts` — reputation/passport listing.
- `src/routes/defense.ts` — incident creation.
- `src/economy/certify.ts` — SafetyInterlock namespace and certification logging.
- `src/provenance/replay.ts` — decision package creation and lookup.
- `src/factory/micro-saas.ts` — tool creation and tenant query.
- `src/economy/reputation.ts` — passport creation.
- `src/defense/autodefense.ts` — incident query.
- `src/provenance/certificate.ts` — certificate tenant assignment.
- `src/do/supervisor.ts` — supervisor prompt context.

This list is the initial confirmed set from repository search, not a claim that all tenant-sensitive code has been exhaustively classified.

## Required remediation order

1. Define a separate internal `AuthenticatedPrincipal` containing verified authentication method and stable principal identifiers. Do not put raw JWTs or secrets in it.
2. For Access, derive issuer and subject only from the already signature-verified JWT payload. The Access tenant claim is a lookup hint, not authority.
3. For API keys, require a unique credential fingerprint resolved against an authoritative active credential record; remove the shared `default` privileged tenant mapping.
4. For sensors, require a unique credential/device ID resolved against an active tenant/device registry; remove shared API secret reuse and static `lb-sensor` identity.
5. Resolve the canonical tenant through the authoritative tenant/credential registry and reject missing, ambiguous, suspended, revoked, legacy, or mismatched bindings.
6. Replace tenant fallbacks in protected paths with explicit fail-closed authorization. Do not blanket-replace strings without preserving public/anonymous route semantics.
7. Add route-level regression tests proving cross-tenant isolation and zero side effects for rejected identities.

## Safety

Do not modify `main`, production D1, Cloudflare bindings, secrets, Workers, Durable Objects, queues, Vectorize or R2 as part of this inventory. Do not treat this document as authorization to deploy or migrate.

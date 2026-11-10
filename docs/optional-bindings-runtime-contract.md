# Optional Cloudflare bindings — runtime contract

ASTON OS declares optional Cloudflare resources in `src/types.ts` so a staging
or partial environment can start without every binding. Call sites must narrow
an optional binding before invoking it.

## Workers AI

- AI-dependent operations fail explicitly with `Workers AI binding not configured`.
- Mission recovery records a low-confidence, no-action hypothesis if AI is absent
  or unavailable. It must never invent a remediation or trigger an automatic
  recovery action from that fallback.
- Simulation and Clairic return an explicit unavailable/empty result instead
  of dereferencing a missing binding.

## Durable Objects

- Defense persistence remains D1-first. If D1 is unavailable and SESSION is
  absent, persistence logs the condition and exits without crashing the request.
- Defense listing returns an empty list when both persistence paths are absent.
- Factory persistence remains D1-first; SESSION fallback reports a clear
  configuration error which the caller handles.

## Release boundary

These guards do not add, remove, rename, or migrate Cloudflare bindings. They
do not deploy the Worker. Production binding configuration remains an operator
responsibility and must be validated independently before release.

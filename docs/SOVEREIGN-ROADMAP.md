# ASTON OS — Sovereign roadmap (from architecture brief)

## Already in this Worker (21.1-sovereign)

| Pillar | Edge implementation |
|--------|---------------------|
| Multi-tenant isolation | `tenantKey()` scopes Durable Object IDs; `/v1/sovereign/tenant` |
| Hot state | SESSION / GRAPH / SUPERVISOR / AGENT / SIMULATION / MISSION / SAFETY |
| Cold state | D1 `DB` bound; Hyperdrive optional later |
| Sandbox | `/v1/sandbox/exec` → SafetyInterlock fail-closed |
| Post-quantum | `webcrypto_modern_algorithms` + `/v1/crypto/*` |
| AI routing | AI Gateway id + model cascade `/v1/ai/routes` |
| R2 journal | Optional `JOURNAL` binding (soft-fail) |

## Dashboard steps still required for full brief

1. **Workers for Platforms** — create a dispatch namespace; deploy per-customer Worker scripts (not a single shared isolate).
2. **Hyperdrive** — attach Postgres/MySQL; set `HYPERDRIVE` binding.
3. **Containers / Sandbox SDK** — bind runtime so `/sandbox/exec` can run real Linux VMs.
4. **R2** — bucket + `JOURNAL` binding for immutable audit.
5. **AI Gateway** — ensure `sovereign-gateway` exists with fallback providers.

## Non-claims

Workers for Platforms, Containers, and Hyperdrive are **account features**. Shipping code paths does not by itself equal multi-bank certification or “beyond Palantir” production proof.

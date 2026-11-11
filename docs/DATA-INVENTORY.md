# ASTON OS — data inventory

**Status:** initial engineering inventory; product-owner validation required.

| Data class | Examples / source | Processing and destination observed | Sensitivity |
|---|---|---|---|
| Authentication material | API key, Cloudflare Access JWT, staging audit token | Request authentication; runtime secrets; JWT headers | Secret |
| Identity / tenant metadata | actor, tenant, roles, clearance, plan | Access control and tenant scoping; Worker memory, D1/DO records and logs | Confidential |
| User prompts and chat history | message, prompt, supplied history | Workers AI; optional Session Durable Object | Potentially sensitive |
| Model responses | answer, voice text | Returned to caller; optional Session Durable Object | Potentially sensitive |
| Ingested content | RAG text, source, chunks, embeddings | D1, Vectorize, optional R2/lineage | Depends on source |
| Operational records | agent plans/actions, risk assessments, incidents, approvals | D1, Durable Objects, optional R2/Queues | Confidential |
| Audit / lineage metadata | actor, action, timestamps, object IDs, decisions | D1, R2 journal, Durable Objects | Confidential |
| Payment/economy metadata | quote, wallet hint, payment method, exposure | Application records / optional D1 | Potentially sensitive |
| Infrastructure configuration | binding names, deployment profile, model IDs | Wrangler config and Worker environment | Internal; secrets must never be committed |

## Handling rules

1. Use synthetic data in staging; never copy customer records or production credentials into audit fixtures.
2. Never log tokens, passwords, private keys, full authorization headers, or sensitive request payloads.
3. Treat prompts, uploaded text, responses, embeddings, and lineage metadata as potentially sensitive until classified.
4. Scope records by verified tenant claims; never use a caller-controlled tenant header as an authorization boundary.
5. Keep runtime secrets in Cloudflare secret storage, not source, issue comments, workflow artifacts, or chat.
6. Define retention, deletion, backup, and data-residency requirements before onboarding customer data.

## Owner confirmation required

- Whether payment-card, government, health, or other regulated data is processed.
- Enabled Cloudflare products, regions, and production bindings.
- Whether RAG content/prompts may contain personal or customer data.
- Retention/deletion periods for D1, R2, Vectorize, Durable Objects, queues, logs, and backups.
- Contractual sub-processor list and applicable privacy/data-localization obligations.

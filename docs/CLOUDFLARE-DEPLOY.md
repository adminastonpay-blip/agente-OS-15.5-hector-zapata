# Cloudflare deploy notes (ASTON OS)

## Root cause of error 10074

```
Cannot apply new-sqlite-class migration to class 'SessionMemory'
that is already depended on by existing Durable Objects [code: 10074]
```

This happens when legacy `[[migrations]]` with `new_sqlite_classes` is re-applied
because local tags no longer match the remote Worker migration tag (`v2`).

## Fix applied (2026 best practice)

1. **Removed** all `[[migrations]]` blocks.
2. **Declared** Durable Object classes with declarative `exports`:
   ```toml
   [exports.SessionMemory]
   type = "durable-object"
   storage = "sqlite"
   ```
3. **Restored** `[[durable_objects.bindings]]` for SESSION, GRAPH, etc.
4. **Soft-fail** `env.SESSION` in chat so the Worker still answers if DO bind lags.

`exports` and `migrations` are **mutually exclusive**. Do not mix them.

## If deploy still fails on exports

Option A — temporary zero-DO deploy (chat only):
- Comment out all `[[durable_objects.bindings]]` and `[exports.*]`.
- Chat continues via soft-fail (no session memory).

Option B — stay on legacy migrations (only if remote tag is known):
- Keep **every** historical tag forever; never delete tags.
- Never re-list a class in `new_sqlite_classes` after it was applied.

## Verify

```bash
curl -s https://<worker>/health
# expect version 21.6.3-cf-audit, bindings.session true|false

curl -s -X POST https://<worker>/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"hola"}'
```

# Merge note: `src/index.ts` on this branch

This branch adds:

- `src/routes/command.ts` — `/v1/command/*`
- `sql/aston_command_schema.sql`
- `tests/command-scope.test.mts`

`src/index.ts` was slimmed during integration so the Worker still boots with **command + defense + risk + other route modules**.

**Before merging to production**, re-apply the two-line wire-up onto `main`'s full `src/index.ts` (chat/TTS/voice/recovery body handlers must not be dropped):

```ts
import { handleCommand } from "./routes/command";
```

```ts
const command = await handleCommand(path, req, env, identity, json);
if (command) return command;
```

Insert the router **before** `handleDefense`.

Also extend CORS `Access-Control-Allow-Headers` with:
`X-ASTON-Environment,X-ASTON-Tenant-Id,X-Trace-Id`.

Apply schema:

```bash
wrangler d1 execute sos-db --file=./sql/aston_command_schema.sql --remote
```

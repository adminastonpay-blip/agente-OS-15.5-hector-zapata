# Wire status

`src/index.ts` re-exports Durable Object classes and defaults to `./worker-app`.

`src/worker-app.ts` calls:

```ts
const scanned = await tryScannerRoutes(path, req.method, req, env);
if (scanned) return scanned;
```

before `authorizeApiRequest`.

Public routes:
- `POST /v1/audit` — attestation (no findings in response)
- `POST /api/scan` — interactive lab scan; with `email` field → attestation path

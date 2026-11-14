# Wire `/v1/audit` in `src/index.ts`

Replace:

```ts
import { handleSurfaceScan } from "./scanner/index";
```

with:

```ts
import { tryScannerRoutes } from "./scanner/routes";
```

Replace:

```ts
if (path === "/api/scan" && req.method === "POST") return handleSurfaceScan(req, env);
```

with:

```ts
const scanned = await tryScannerRoutes(path, req.method, req, env);
if (scanned) return scanned;
```

Keep this **before** `authorizeApiRequest` so the enterprise demo stays public + rate-limited.

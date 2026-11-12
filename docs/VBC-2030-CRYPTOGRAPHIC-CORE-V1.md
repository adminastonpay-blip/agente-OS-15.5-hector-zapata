# ASTON VBC-2030 Cryptographic Core — V1

This change adds the isolated staging D1 audit registry and deterministic Evidence Graph manifest generator. It does not deploy the Worker or create/bind a Cloudflare D1 database.

## Components

- Migration: `migrations/vbc/0001_vbc_registry.sql`
- Worker module: `src/vbc/evidence-manifest.ts`
- Worker routing: `src/index.ts`
- Staging route allow-list: `src/audit/staging-route-guard.ts`
- Environment contract: `VBC_REGISTRY?: D1Database` in `src/types.ts`

## Staging infrastructure prerequisite

Create a dedicated D1 database for VBC staging, apply the migration, and bind it to the isolated Worker as `VBC_REGISTRY`. The staging Wrangler file intentionally does not contain a fabricated database ID. Keep the existing `AUDIT_ARCHIVE` R2 binding dedicated to staging. Do not bind this registry to production.

The Worker fails closed with `vbc_registry_or_archive_binding_unavailable` until both bindings exist. No deployment is part of this change.

## Trusted orchestrator API

All routes require the staging-only `AUDIT_SECRET` in the `x-audit-token` header. The secret must remain server-side and must never be exposed to Shopify Liquid, browser JavaScript, or an App Proxy response.

### 1. Create run

`POST /v1/vbc/runs`

```json
{
  "tenant_id": "tenant-staging",
  "suite_name": "ARP-100",
  "suite_version": "1.0.0",
  "software_hash": "<64 lowercase hex SHA-256>",
  "target_commit": "<40 or 64 lowercase hex commit>",
  "expected_test_count": 12
}
```

The Worker generates the immutable UUID `run_id` and records the run as `running`.

### 2. Append evaluated results

`POST /v1/vbc/runs/{run_id}/results`

```json
{
  "results": [
    {
      "test_name": "cloudflare.typescript",
      "status_http": 200,
      "passed": true,
      "details": { "tool": "tsc", "conclusion": "success" }
    }
  ]
}
```

The caller must be the trusted ARP evaluator, not the browser. The shared staging secret authenticates the caller; production-grade workload identity/mTLS and per-tenant authorization remain a release requirement. Results are append-only, unique by run and test name, and evidence hashes are computed by the Worker over canonical JSON.

### 3. Finalize and generate manifest

`POST /v1/vbc/runs/{run_id}/finalize`

Finalization succeeds only when the recorded test count exactly matches `expected_test_count` and every result is explicitly marked passed by the trusted evaluator. Otherwise the run is rejected or marked failed. A successful run generates canonical `manifest.json`, writes it to staging R2 under a content-addressed key, and stores the digest and manifest record in D1.

The manifest contains:
- run, suite, software hash and target commit;
- each test result and its evidence payload/hash;
- an ASTON Evidence Graph of run → software, run → test, and test → evidence edges;
- explicit trust states for features not yet implemented.

## Digest semantics

The manifest's SHA-256 is calculated over the exact canonical JSON UTF-8 bytes stored in R2. The digest is recorded separately in D1 and returned by the API; it is not recursively embedded as its own digest. This avoids self-reference. The canonicalizer sorts object keys recursively and preserves array order. It is a project-specific canonicalization profile, not a claim of RFC 8785 conformance.

## Current trust boundaries

This V1 does **not** implement a PDF, PAdES signature, RFC 3161 timestamp, OpenTimestamps submission/Bitcoin confirmation, or public third-party verifier. The manifest explicitly reports those states as not implemented/not anchored. A successful ARP-100 run is not, by itself, a signed certificate.

## Dry-run checklist (not executed by this change)

1. Create isolated D1 database and apply the migration.
2. Bind D1 as `VBC_REGISTRY` to the staging Worker only.
3. Confirm the existing staging `AUDIT_ARCHIVE` bucket is present.
4. Set `AUDIT_SECRET` only in the staging Worker.
5. Run a synthetic staging ARP-100 suite using a trusted evaluator.
6. Verify exact expected test inventory, append-only rows, manifest digest, R2 object bytes, and failure-path behavior.
7. Confirm production Worker, production D1, production R2 and Shopify live theme remain unchanged.

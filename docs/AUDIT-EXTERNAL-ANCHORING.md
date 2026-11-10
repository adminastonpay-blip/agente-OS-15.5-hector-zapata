# ASTON OS — External Audit Anchoring (R2 + OpenTimestamps)

## Purpose and trust boundaries

ASTON writes tenant-scoped audit checkpoints to a dedicated R2 bucket. A checkpoint contains a tenant pseudonym, event count, the chain root, the previous anchored root, and the first/last event hashes. It intentionally excludes prompts, request bodies, credentials, and raw business payloads.

The Durable Object emits a checkpoint after each 100 new events and at least once per hour when new events exist. Checkpoint object keys are content-addressed by tenant hash, event count, and root hash. Existing keys are checked for exact content equality before being reused.

OpenTimestamps runs outside the Worker runtime. The scheduled GitHub Action stamps each R2 checkpoint, upgrades pending proofs, and stores a final `.ots` receipt only after the OpenTimestamps CLI reports a Bitcoin block confirmation. Pending receipts live under a separate retryable prefix.

The Worker verification endpoint delegates cryptographic OpenTimestamps/Bitcoin-header verification to the dedicated `OTS_VERIFIER` service binding. It accepts a result only when that verifier confirms the exact checkpoint root and returns a positive Bitcoin block height. If R2 or the verifier is unavailable, the endpoint returns 503; it never reports a pending or unverified receipt as valid.

**Important:** the verifier service itself must be deployed and independently validated before this endpoint can return success. The service binding is an explicit integration boundary, not an implemented Bitcoin verifier hidden inside the Worker. GitHub's `ots verify` command is the current automated verification path.

## R2 setup — required operator action

Create a dedicated bucket, for example `aston-audit-evidence`. Do not reuse the general journal bucket. Then configure Bucket Lock rules before enabling the integration:

- Prefix `audit/anchors/`: indefinite retention.
- Prefix `audit/ots/v1/`: indefinite retention.
- Do not lock `audit/ots-pending/`; pending proofs must be upgradeable until Bitcoin confirms them.

Cloudflare documents that bucket locks prevent overwriting and deleting matching objects, including by lifecycle rules, once the rule is active. A bucket administrator can still change bucket configuration, so separate the lock-policy administrator from the Worker and GitHub credentials. Object Lock is not a defense against compromise of every privileged Cloudflare account.

Dashboard: R2 > bucket > Settings > Bucket lock rules. Add the two indefinite rules above. Or use Wrangler after reviewing the target bucket:

```bash
npx wrangler r2 bucket lock add aston-audit-evidence --prefix audit/anchors/ --condition-type Indefinite
npx wrangler r2 bucket lock add aston-audit-evidence --prefix audit/ots/v1/ --condition-type Indefinite
npx wrangler r2 bucket lock list aston-audit-evidence
```

Check the exact CLI flags supported by the installed Wrangler version before running. Cloudflare's API accepts rules with `condition: { "type": "Indefinite" }`.

After the bucket exists, add the following binding to both `wrangler.staging.toml` and (only after staging acceptance) the production config. Replace the bucket name with the real bucket name; do not copy the example literally:

```toml
[[r2_buckets]]
binding = "AUDIT_ARCHIVE"
bucket_name = "aston-audit-evidence"
```

Do not set `AUDIT_ANCHOR_REQUIRED = "true"` until the R2 binding, bucket-lock rules, scheduled OTS workflow, and verifier service binding have all been proven in staging. When enabled, missing R2 causes audit writes to fail closed.

## GitHub Actions secrets

Configure these repository Actions secrets:

- `ASTON_R2_ENDPOINT`: `https://<account-id>.r2.cloudflarestorage.com`
- `ASTON_AUDIT_R2_BUCKET`: actual bucket name
- `ASTON_R2_ACCESS_KEY_ID`: restricted R2 S3 access key
- `ASTON_R2_SECRET_ACCESS_KEY`: matching secret

The R2 credential used by GitHub should have only the minimum bucket access required to list/read checkpoints and write pending/final OTS receipts. It must not have permission to alter bucket lock rules.

Run `ASTON External Audit Anchor (OpenTimestamps)` manually once the secrets exist. It also runs hourly at minute 17. If secrets are absent, the workflow emits a warning and does not claim a timestamp was created.

## Verifier service contract

Bind a separately deployed, hardened verifier as `OTS_VERIFIER`:

```toml
[[services]]
binding = "OTS_VERIFIER"
service = "<deployed-ots-verifier-worker>"
```

The Worker sends `POST /verify` with:
- `checkpoint`: parsed checkpoint metadata
- `manifest_base64`: exact original checkpoint bytes that were stamped
- `proof_base64`: exact `.ots` receipt bytes
- `algorithm`: `opentimestamps-bitcoin`

The verifier must independently run a maintained OpenTimestamps verification implementation against Bitcoin headers (not trust the manifest's claimed block number), verify the proof against the exact manifest bytes, and return JSON:
`{ "ok": true, "confirmed": true, "root_hash": "<same root>", "block_height": 900000, "timestamp": 1794300000 }`.

Pending calendar attestations, invalid proofs, mismatched roots, missing block headers, and service errors must never return `confirmed: true`.

## Worker endpoints and behavior

- Internal Durable Object append: `/audit/append` (called by governed-agent lifecycle).
- Internal Durable Object verify: `/audit/anchor/verify`.
- Authenticated Worker route: `POST /v1/audit/anchor/verify`, body `{ "event_count": 100 }`. The tenant is taken from verified identity, never from caller input.

The route returns 503 while the R2 receipt or verifier is unavailable, 404 when the requested checkpoint does not exist, and 200 only for a confirmed proof matching the exact local root. It is restricted to authenticated protected writes by the existing API access boundary.

## Staging E2E acceptance criteria

1. Create a dedicated staging R2 bucket and activate both lock rules.
2. Bind `AUDIT_ARCHIVE` and deploy the dedicated `OTS_VERIFIER` service binding in the staging Worker.
3. Configure GitHub Actions R2 secrets.
4. Create 100 governed-agent events in one tenant; confirm a checkpoint object appears under `audit/anchors/v1/`.
5. Confirm a pending proof appears under `audit/ots-pending/v1/`, then a confirmed receipt under `audit/ots/v1/` after Bitcoin confirmation.
6. Call `POST /v1/audit/anchor/verify` as an authorized operator and require the returned root hash to equal the local checkpoint root and a positive Bitcoin block height.
7. Tamper with a test copy of the manifest or provide a proof for another root; require verification failure and no allow decision.
8. Run the Trust Fabric → ASTON OS Staging service-binding test once the Trust Fabric service name and binding are configured.

## Current implementation boundary

This PR adds the Worker-side R2 checkpoint writer, 100-event/hourly checkpoint schedule, append-only content-addressed object keys, OTS stamping/upgrade workflow, authenticated verification route, and a fail-closed verifier service-binding contract with regression tests.

No live R2 bucket, Bucket Lock rule, Cloudflare binding, GitHub secret, OTS verifier deployment, Bitcoin confirmation, or Trust Fabric service binding is configured by this repository change. Therefore this PR does **not** claim live WORM retention, a confirmed Bitcoin timestamp, or a completed cross-service E2E test. Those are staging acceptance gates, not CI claims.

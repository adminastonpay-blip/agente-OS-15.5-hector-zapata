#!/usr/bin/env bash
set -euo pipefail

: "${R2_ENDPOINT:?Set R2_ENDPOINT}"
: "${R2_BUCKET:?Set R2_BUCKET}"
: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY}"

# Cloudflare R2 endpoint secrets are sometimes saved as a bare hostname.
# AWS CLI requires an absolute URL; normalize to HTTPS without exposing the value.
if [[ "$R2_ENDPOINT" == http://* ]]; then
  echo "R2_ENDPOINT must use HTTPS." >&2
  exit 2
elif [[ "$R2_ENDPOINT" != https://* ]]; then
  R2_ENDPOINT="https://${R2_ENDPOINT#//}"
fi
R2_ENDPOINT="${R2_ENDPOINT%/}"
python - "$R2_ENDPOINT" <<'PY'
import sys
from urllib.parse import urlparse

parsed = urlparse(sys.argv[1])
if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
    raise SystemExit("R2_ENDPOINT must be a valid HTTPS endpoint URL.")
PY

command -v aws >/dev/null || { echo "AWS CLI is required" >&2; exit 2; }
command -v ots >/dev/null || { echo "opentimestamps-client is required (pip install opentimestamps-client)" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
command -v sha256sum >/dev/null || { echo "sha256sum is required" >&2; exit 2; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

aws s3api list-objects-v2 --endpoint-url "$R2_ENDPOINT" --bucket "$R2_BUCKET" \
  --prefix "evidence/anchors/v1/" --query 'Contents[].Key' --output json | jq -r '.[]?' > "$tmp/keys.txt"

while IFS= read -r key; do
  [[ "$key" == evidence/anchors/v1/*.json ]] || continue
  name="$(basename "$key" .json)"
  tenant_path="$(dirname "$key" | sed 's#^evidence/anchors/v1/##')"
  final_key="evidence/ots/v1/$tenant_path/$name.ots"
  # Bucket-wide indefinite retention makes every object immutable, including pending proofs.
  # Therefore each upgrade is stored under a new content-addressed key; no pending object is overwritten.
  pending_prefix="pending/ots/v1/$tenant_path/$name/"

  if aws s3api head-object --endpoint-url "$R2_ENDPOINT" --bucket "$R2_BUCKET" --key "$final_key" >/dev/null 2>&1; then
    echo "Already Bitcoin-anchored: $final_key"
    continue
  fi

  manifest="$tmp/$name.json"
  proof="$tmp/$name.ots"
  aws s3 cp --endpoint-url "$R2_ENDPOINT" "s3://$R2_BUCKET/$key" "$manifest" >/dev/null

  latest_pending="$(aws s3api list-objects-v2 --endpoint-url "$R2_ENDPOINT" --bucket "$R2_BUCKET" \
    --prefix "$pending_prefix" --query 'Contents[].Key' --output json | jq -r 'sort | last // empty')"

  if [[ -n "$latest_pending" ]]; then
    aws s3 cp --endpoint-url "$R2_ENDPOINT" "s3://$R2_BUCKET/$latest_pending" "$proof" >/dev/null
    ots upgrade "$proof" || true
  else
    ots stamp "$manifest"
    mv "$manifest.ots" "$proof"
  fi

  proof_hash="$(sha256sum "$proof" | awk '{print $1}')"
  pending_key="${pending_prefix}$(date -u +%Y%m%dT%H%M%S%N)-${proof_hash}.ots"

  if [[ -z "${OTS_BITCOIN_NODE:-}" ]]; then
    aws s3 cp --endpoint-url "$R2_ENDPOINT" "$proof" "s3://$R2_BUCKET/$pending_key" \
      --content-type "application/vnd.opentimestamps"
    echo "Proof stored append-only but not independently confirmed: configure OTS_BITCOIN_NODE."
    continue
  fi

  verification="$(ots --bitcoin-node "$OTS_BITCOIN_NODE" verify "$proof" 2>&1 || true)"
  printf '%s\n' "$verification"

  if grep -q "Success! Bitcoin block" <<<"$verification"; then
    aws s3 cp --endpoint-url "$R2_ENDPOINT" "$proof" "s3://$R2_BUCKET/$final_key" \
      --content-type "application/vnd.opentimestamps"
    echo "Confirmed and stored immutable proof: $final_key"
  else
    aws s3 cp --endpoint-url "$R2_ENDPOINT" "$proof" "s3://$R2_BUCKET/$pending_key" \
      --content-type "application/vnd.opentimestamps"
    echo "Bitcoin confirmation pending; stored append-only proof: $pending_key"
  fi
done < "$tmp/keys.txt"

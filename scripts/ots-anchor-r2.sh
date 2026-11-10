#!/usr/bin/env bash
set -euo pipefail

: "${R2_ENDPOINT:?Set R2_ENDPOINT}"
: "${R2_BUCKET:?Set R2_BUCKET}"
: "${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY}"

command -v aws >/dev/null || { echo "AWS CLI is required" >&2; exit 2; }
command -v ots >/dev/null || { echo "opentimestamps-client is required (pip install opentimestamps-client)" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

aws s3api list-objects-v2 --endpoint-url "$R2_ENDPOINT" --bucket "$R2_BUCKET" \
  --prefix "audit/anchors/v1/" --query 'Contents[].Key' --output json | jq -r '.[]?' > "$tmp/keys.txt"

while IFS= read -r key; do
  [[ "$key" == audit/anchors/v1/*.json ]] || continue
  name="$(basename "$key" .json)"
  tenant_path="$(dirname "$key" | sed 's#^audit/anchors/v1/##')"
  final_key="audit/ots/v1/$tenant_path/$name.ots"
  pending_key="audit/ots-pending/v1/$tenant_path/$name.ots"

  if aws s3api head-object --endpoint-url "$R2_ENDPOINT" --bucket "$R2_BUCKET" --key "$final_key" >/dev/null 2>&1; then
    echo "Already Bitcoin-anchored: $final_key"
    continue
  fi

  manifest="$tmp/$name.json"
  proof="$tmp/$name.ots"
  aws s3 cp --endpoint-url "$R2_ENDPOINT" "s3://$R2_BUCKET/$key" "$manifest" >/dev/null

  if aws s3api head-object --endpoint-url "$R2_ENDPOINT" --bucket "$R2_BUCKET" --key "$pending_key" >/dev/null 2>&1; then
    aws s3 cp --endpoint-url "$R2_ENDPOINT" "s3://$R2_BUCKET/$pending_key" "$proof" >/dev/null
    ots upgrade "$proof" || true
  else
    ots stamp "$manifest"
    mv "$manifest.ots" "$proof"
  fi

  verification="$(ots verify "$proof" 2>&1 || true)"
  printf '%s\n' "$verification"

  if grep -q "Success! Bitcoin block" <<<"$verification"; then
    aws s3 cp --endpoint-url "$R2_ENDPOINT" "$proof" "s3://$R2_BUCKET/$final_key" \
      --content-type "application/vnd.opentimestamps" 
    echo "Confirmed and stored immutable proof: $final_key"
  else
    aws s3 cp --endpoint-url "$R2_ENDPOINT" "$proof" "s3://$R2_BUCKET/$pending_key" \
      --content-type "application/vnd.opentimestamps"
    echo "Bitcoin confirmation pending; stored retryable proof: $pending_key"
  fi
done < "$tmp/keys.txt"

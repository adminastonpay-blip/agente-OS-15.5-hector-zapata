export interface AuditCheckpoint {
  schema: "aston.audit.checkpoint.v1";
  tenant_hash: string;
  event_count: number;
  root_hash: string;
  previous_anchor_root: string;
  first_event_hash: string;
  last_event_hash: string;
  last_event_ts: number;
  created_at: number;
}

export interface AuditAnchorResult {
  key: string;
  checkpoint: AuditCheckpoint;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function writeImmutableCheckpoint(
  bucket: R2Bucket,
  checkpoint: AuditCheckpoint
): Promise<AuditAnchorResult> {
  if (!/^[a-f0-9]{64}$/.test(checkpoint.tenant_hash) ||
      !/^[a-f0-9]{64}$/.test(checkpoint.root_hash) ||
      !Number.isSafeInteger(checkpoint.event_count) || checkpoint.event_count < 1) {
    throw new Error("invalid_audit_checkpoint");
  }
  const key = `audit/anchors/v1/${checkpoint.tenant_hash}/${String(checkpoint.event_count).padStart(12, "0")}-${checkpoint.root_hash}.json`;
  const body = JSON.stringify(checkpoint);
  const existing = await bucket.head(key);
  if (existing) {
    if (existing.customMetadata?.root_hash !== checkpoint.root_hash ||
        existing.customMetadata?.event_count !== String(checkpoint.event_count)) {
      throw new Error("audit_checkpoint_key_conflict");
    }
    const stored = await bucket.get(key);
    if (!stored || await stored.text() !== body) throw new Error("audit_checkpoint_content_mismatch");
    return { key, checkpoint };
  }
  await bucket.put(key, body, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      schema: checkpoint.schema,
      tenant_hash: checkpoint.tenant_hash,
      event_count: String(checkpoint.event_count),
      root_hash: checkpoint.root_hash,
    },
  });
  return { key, checkpoint };
}

export async function verifyExternalOtsAnchor(
  verifier: Fetcher,
  bucket: R2Bucket,
  checkpointKey: string,
  expectedRootHash: string
): Promise<{ ok: true; confirmed: true; block_height: number; timestamp?: number } |
           { ok: false; confirmed: false; reason: string }> {
  const manifest = await bucket.get(checkpointKey);
  if (!manifest) return { ok: false, confirmed: false, reason: "checkpoint_not_found" };
  const manifestBytes = new Uint8Array(await manifest.arrayBuffer());
  const manifestText = new TextDecoder().decode(manifestBytes);
  let checkpoint: AuditCheckpoint;
  try { checkpoint = JSON.parse(manifestText) as AuditCheckpoint; }
  catch { return { ok: false, confirmed: false, reason: "checkpoint_invalid_json" }; }
  if (checkpoint.schema !== "aston.audit.checkpoint.v1" ||
      checkpoint.root_hash !== expectedRootHash ||
      !/^[a-f0-9]{64}$/.test(checkpoint.root_hash)) {
    return { ok: false, confirmed: false, reason: "checkpoint_root_mismatch" };
  }
  const proofKey = checkpointKey
    .replace("audit/anchors/v1/", "audit/ots/v1/")
    .replace(/\.json$/, ".ots");
  const proof = await bucket.get(proofKey);
  if (!proof) return { ok: false, confirmed: false, reason: "ots_proof_pending" };
  const proofBytes = new Uint8Array(await proof.arrayBuffer());
  let binary = "";
  for (const byte of proofBytes) binary += String.fromCharCode(byte);
  const proofBase64 = btoa(binary);
  const response = await verifier.fetch("https://ots-verifier.internal/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      algorithm: "opentimestamps-bitcoin",
      checkpoint,
      manifest_base64: btoa(manifestText),
      proof_base64: proofBase64,
    }),
  });
  if (!response.ok) return { ok: false, confirmed: false, reason: "ots_verifier_unavailable" };
  const result = await response.json<{
    ok: boolean; confirmed: boolean; root_hash: string; block_height?: number; timestamp?: number;
  }>().catch(() => null);
  if (!result || !result.ok || !result.confirmed || result.root_hash !== expectedRootHash ||
      !Number.isSafeInteger(result.block_height) || (result.block_height ?? 0) < 1) {
    return { ok: false, confirmed: false, reason: "ots_proof_not_confirmed_or_invalid" };
  }
  return { ok: true, confirmed: true, block_height: result.block_height!, timestamp: result.timestamp };
}

export interface AuditChainEntry {
  previousHash: string;
  record: string;
  hash: string;
}

export async function hashAuditRecord(previousHash: string, record: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(previousHash + "\n" + record)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyAuditChain(entries: AuditChainEntry[]): Promise<boolean> {
  let previousHash = "GENESIS";
  for (const entry of entries) {
    if (entry.previousHash !== previousHash) return false;
    const expected = await hashAuditRecord(previousHash, entry.record);
    if (expected !== entry.hash) return false;
    previousHash = entry.hash;
  }
  return true;
}

const PII_PATTERNS: Array<{ kind: string; re: RegExp; clearance: string }> = [
  { kind: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, clearance: "internal" },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, clearance: "confidential" },
  { kind: "api_key", re: /\b(sk|pk|ghp|xoxb)_[A-Za-z0-9]{20,}\b/g, clearance: "secret" },
  { kind: "private_ip", re: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g, clearance: "confidential" },
  { kind: "credit_card", re: /\b(?:\d[ -]*?){13,16}\b/g, clearance: "confidential" },
];

const RANK: Record<string, number> = { public: 0, internal: 1, confidential: 2, secret: 3 };

async function tokenize(value: string, kind: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${kind}:${value}`));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `⟦${kind.toUpperCase()}_${hex.slice(0, 12)}⟧`;
}

export async function maskForAgent(
  input: string, agentClearance: string, secret: string
): Promise<{ masked: string; vault: Map<string, string> }> {
  const vault = new Map<string, string>();
  let masked = input;
  for (const p of PII_PATTERNS) {
    if (RANK[agentClearance] >= RANK[p.clearance]) continue;
    const matches = [...input.matchAll(p.re)];
    for (const m of matches) {
      const tok = await tokenize(m[0], p.kind, secret);
      vault.set(tok, m[0]);
      masked = masked.replaceAll(m[0], tok);
    }
  }
  return { masked, vault };
}

export function restoreMaskedDataFromVault(text: string, vault: Map<string, string>): string {
  let out = text;
  for (const [tok, real] of vault) out = out.replaceAll(tok, real);
  return out;
}

/** @deprecated This restores masked PII tokens, not backups. */
export const restoreFromVault = restoreMaskedDataFromVault;

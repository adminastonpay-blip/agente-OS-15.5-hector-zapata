import type { Identity } from "../types";

/**
 * Stable, tenant- and actor-scoped Durable Object name for chat memory.
 * The raw session identifier is never used as a global namespace.
 */
export async function sessionStorageKey(identity: Identity, sessionId: string): Promise<string> {
  const tenant = identity.tenant || "unassigned";
  const actor = identity.actor || "unknown";
  const material = [identity.method, tenant, actor, sessionId].join("\\0");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const fingerprint = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `aston-session-v2:${fingerprint}`;
}

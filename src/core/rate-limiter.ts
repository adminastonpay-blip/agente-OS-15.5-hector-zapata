import type { Env } from "../types";

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; unavailable?: boolean };

/**
 * Uses one SQLite-backed SafetyInterlock Durable Object instance per
 * tenant/action. The existing DO handler updates its counter synchronously,
 * serializing concurrent requests that share the same key.
 */
export class RateLimiter {
  constructor(private readonly env: Env) {}

  async check(tenant: string, action: string): Promise<RateLimitResult> {
    const safetyNamespace = this.env.SAFETY;
    if (!safetyNamespace || !tenant || !action) {
      return { allowed: false, unavailable: true };
    }

    try {
      const key = `aston-ai-rate:${tenant}:${action}`;
      const stub = safetyNamespace.get(safetyNamespace.idFromName(key));
      const response = await stub.fetch("https://rate.internal/rate-limit/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 60, window_ms: 60_000 }),
      });
      if (response.status === 429) return { allowed: false };
      if (!response.ok) return { allowed: false, unavailable: true };
      const result = await response.json<{ allowed?: boolean }>().catch(() => ({}));
      return result.allowed === true
        ? { allowed: true }
        : { allowed: false, unavailable: true };
    } catch {
      return { allowed: false, unavailable: true };
    }
  }
}

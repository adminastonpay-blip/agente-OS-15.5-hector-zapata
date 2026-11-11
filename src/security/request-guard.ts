import type { Identity } from "../types";

export type RequestLimit = { ok: true; limit: number } | { ok: false; limit: number };

const PLAN_MAX_BODY: Record<NonNullable<Identity["plan"]>, number> = {
  free: 64 * 1024,
  pro: 512 * 1024,
  sovereign: 2 * 1024 * 1024,
  gov: 2 * 1024 * 1024,
};

/** Enforce both declared and streamed request size; Content-Length is never trusted alone. */
export async function enforceRequestBodyLimit(
  req: Request,
  identity: Identity
): Promise<{ request: Request; result: RequestLimit }> {
  const limit = PLAN_MAX_BODY[identity.plan || "free"];
  const rawLength = req.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength)) return { request: req, result: { ok: false, limit } };
    if (Number(rawLength) > limit) return { request: req, result: { ok: false, limit } };
  }
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" || !req.body) {
    return { request: req, result: { ok: true, limit } };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("request_body_limit_exceeded");
        return { request: req, result: { ok: false, limit } };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  const replayable = new Request(req.url, {
    method: req.method,
    headers,
    body,
    redirect: req.redirect,
  });
  return { request: replayable, result: { ok: true, limit } };
}

export type RateLimitClass = "chat" | "public" | "authenticated-read" | "authenticated-write";

export function rateLimitPolicy(path: string, method: string, identity: Identity): {
  bucket: RateLimitClass;
  limit: number;
  windowMs: number;
} {
  const verb = method.toUpperCase();
  if (path === "/chat" || path === "/v1/chat" || path.endsWith("/chat/stream") || path === "/v1/solve") {
    return { bucket: "chat", limit: identity.method === "public" ? 8 : 30, windowMs: 60_000 };
  }
  if (identity.method === "public") {
    return { bucket: "public", limit: 30, windowMs: 60_000 };
  }
  return {
    bucket: verb === "GET" || verb === "HEAD" ? "authenticated-read" : "authenticated-write",
    limit: verb === "GET" || verb === "HEAD" ? 120 : 40,
    windowMs: 60_000,
  };
}

import type { Env } from "../types";

export type RateLimitResult =
  | { allowed: true; remaining: number; resetAt: number }
  | { allowed: false; remaining: 0; resetAt: number }
  | { allowed: false; unavailable: true };

/** Enforce per-client and (for authenticated users) per-tenant fixed-window limits in a DO. */
export async function checkRequestRateLimit(
  env: Env, identity: Identity, path: string, method: string, clientIp: string | null
): Promise<RateLimitResult> {
  if (!env.SAFETY) return { allowed: false, unavailable: true };
  const policy = rateLimitPolicy(path, method, identity);
  const keys = ["ip:" + (clientIp || "unknown") + ":" + policy.bucket];
  if (identity.method !== "public") keys.push("tenant:" + identity.tenant + ":" + policy.bucket);
  let remaining = policy.limit;
  let resetAt = Date.now() + policy.windowMs;
  for (const key of keys) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const id = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    try {
      const stub = env.SAFETY.get(env.SAFETY.idFromName("rate-" + id));
      const response = await stub.fetch("https://rate-limit/check", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: policy.limit, window_ms: policy.windowMs }),
      });
      const result = await response.json<{ allowed: boolean; remaining: number; reset_at: number }>().catch(() => null);
      if (response.status === 429 && result) return { allowed: false, remaining: 0, resetAt: result.reset_at };
      if (!response.ok || !result) return { allowed: false, unavailable: true };
      remaining = Math.min(remaining, result.remaining);
      resetAt = Math.max(resetAt, result.reset_at);
      if (!result.allowed) return { allowed: false, remaining: 0, resetAt: result.reset_at };
    } catch { return { allowed: false, unavailable: true }; }
  }
  return { allowed: true, remaining, resetAt };
}

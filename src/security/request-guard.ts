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

export type RateLimitClass = "chat" | "public" | "authenticated";

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
    bucket: "authenticated",
    limit: verb === "GET" || verb === "HEAD" ? 120 : 40,
    windowMs: 60_000,
  };
}

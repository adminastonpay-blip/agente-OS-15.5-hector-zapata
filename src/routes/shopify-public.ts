import type { Env, Identity } from "../types";

const PRIVATE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const privileged = (identity: Identity) =>
  identity.method !== "public" &&
  (identity.roles.includes("admin") || identity.roles.includes("executor"));

function allowedOrigins(env: Env): Set<string> {
  return new Set(
    String(env.SHOPIFY_ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function response(
  data: unknown,
  status: number,
  origin?: string
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    ...PRIVATE_HEADERS,
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function originFor(req: Request, env: Env): string | null {
  const origin = req.headers.get("Origin");
  if (!origin || !allowedOrigins(env).has(origin)) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:") return null;
    return origin;
  } catch {
    return null;
  }
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeKey(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return bytes.byteLength === 32 ? bytes : null;
  } catch {
    return null;
  }
}

async function encryptLead(
  plaintext: string,
  secret: string
): Promise<{ ciphertext: string; iv: string; emailHash: string } | null> {
  const raw = decodeKey(secret);
  if (!raw) return null;
  const aesKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("aston-ciso-lead:v1") },
    aesKey,
    new TextEncoder().encode(plaintext)
  );
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const email = JSON.parse(plaintext).email as string;
  const emailHash = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    new TextEncoder().encode(email.toLowerCase())
  );
  return {
    ciphertext: encode(new Uint8Array(ciphertext)),
    iv: encode(iv),
    emailHash: encode(new Uint8Array(emailHash)),
  };
}

async function verifyTurnstile(
  token: string,
  secret: string,
  hostname: string
): Promise<boolean> {
  const body = new URLSearchParams({ secret, response: token });
  const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!result.ok) return false;
  const data = await result.json<{
    success?: boolean;
    hostname?: string;
    action?: string;
  }>().catch(() => null);
  return data?.success === true &&
    data.hostname === hostname &&
    data.action === "aston_ciso_lead";
}

/** Public Shopify surface. Only sanitized health metadata leaves this Worker. */
export async function handleShopifyPublic(
  path: string,
  req: Request,
  env: Env
): Promise<Response | null> {
  if (path !== "/v1/public/health" && path !== "/v1/public/leads/ciso") return null;
  const origin = originFor(req, env);
  if (!origin) return response({ ok: false, error: "origin_not_allowed" }, 403);
  if (path === "/v1/public/health") {
    if (req.method !== "GET") return response({ ok: false, error: "method_not_allowed" }, 405, origin);
    if (!env.DB) return response({ ok: false, status: "unconfigured" }, 503, origin);
    const started = performance.now();
    try {
      await env.DB.prepare("SELECT 1 AS probe").first();
      return response({
        ok: true,
        status: "healthy",
        latency_ms: Math.max(0, Math.round(performance.now() - started)),
        checked_at: new Date().toISOString(),
      }, 200, origin);
    } catch {
      return response({
        ok: false,
        status: "unhealthy",
        latency_ms: Math.max(0, Math.round(performance.now() - started)),
      }, 503, origin);
    }
  }

  if (req.method !== "POST") return response({ ok: false, error: "method_not_allowed" }, 405, origin);
  if (!env.DB || !env.TURNSTILE_SECRET_KEY || !env.LEADS_ENCRYPTION_KEY) {
    return response({ ok: false, error: "lead_intake_not_configured" }, 503, origin);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json<Record<string, unknown>>();
  } catch {
    return response({ ok: false, error: "invalid_json" }, 400, origin);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const company = typeof body.company === "string" ? body.company.trim() : "";
  const role = typeof body.role === "string" ? body.role.trim() : "";
  const interest = typeof body.interest === "string" ? body.interest.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const token = typeof body.turnstile_token === "string" ? body.turnstile_token : "";
  const consent = body.consent === true;

  if (
    name.length < 2 || name.length > 120 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
    company.length < 2 || company.length > 160 ||
    role.length > 120 || interest.length > 100 || message.length > 3000 ||
    !consent || !token || token.length > 2048
  ) {
    return response({ ok: false, error: "invalid_lead_payload" }, 400, origin);
  }

  let hostname: string;
  try { hostname = new URL(origin).hostname; } catch {
    return response({ ok: false, error: "origin_not_allowed" }, 403);
  }
  try {
    if (!(await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, hostname))) {
      return response({ ok: false, error: "human_verification_failed" }, 403, origin);
    }
  } catch {
    return response({ ok: false, error: "human_verification_unavailable" }, 503, origin);
  }

  const payload = JSON.stringify({
    name, email, company, role, interest, message,
    consent_at: new Date().toISOString(),
    source: "shopify-ciso-form",
  });
  const encrypted = await encryptLead(payload, env.LEADS_ENCRYPTION_KEY);
  if (!encrypted) return response({ ok: false, error: "lead_encryption_not_configured" }, 503, origin);

  const now = Date.now();
  const leadId = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO ciso_leads (id, email_hash, payload_ciphertext, payload_iv, consent_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      leadId,
      encrypted.emailHash,
      encrypted.ciphertext,
      encrypted.iv,
      "aston-privacy-v1",
      now,
      now + 180 * 24 * 60 * 60 * 1000
    ).run();
    return response({ ok: true, status: "received", reference: leadId }, 202, origin);
  } catch {
    return response({ ok: false, error: "lead_storage_unavailable" }, 503, origin);
  }
}

/** Private health probe for authenticated Engineering operators only. */
export async function handleEngineeringHealth(
  path: string,
  req: Request,
  env: Env,
  identity: Identity
): Promise<Response | null> {
  if (path !== "/v1/engineering/health") return null;
  if (req.method !== "GET") return response({ ok: false, error: "method_not_allowed" }, 405);
  if (!privileged(identity)) return response({ ok: false, error: "engineering_privileged_role_required" }, 403);
  if (!env.DB) return response({ ok: false, status: "unconfigured" }, 503);
  const started = performance.now();
  try {
    await env.DB.prepare("SELECT 1 AS probe").first();
    return response({
      ok: true,
      status: "healthy",
      latency_ms: Math.max(0, Math.round(performance.now() - started)),
      checked_at: new Date().toISOString(),
    }, 200);
  } catch {
    return response({
      ok: false,
      status: "unhealthy",
      latency_ms: Math.max(0, Math.round(performance.now() - started)),
    }, 503);
  }
}

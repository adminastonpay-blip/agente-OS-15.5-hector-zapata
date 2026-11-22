import type { Env, Identity } from "./types";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function normalizeTenant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tenant = value.trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(tenant) ? tenant : null;
}

/** Missing Access tenant claims must never collapse unrelated users into one shared tenant. */
export function resolveTenantClaim(value: unknown, actorFingerprint: string): string {
  return normalizeTenant(value) || `unassigned-${actorFingerprint.slice(0, 32)}`;
}

function normalizeRoles(value: unknown): string[] {
  if (!Array.isArray(value)) return ["viewer"];
  const roles = value.filter((role): role is string =>
    typeof role === "string" && /^[a-zA-Z0-9:_-]{1,40}$/.test(role)
  ).slice(0, 16);
  return roles.length ? [...new Set(roles)] : ["viewer"];
}

function normalizeClearance(value: unknown): Identity["clearance"] {
  return value === "public" || value === "internal" ||
    value === "confidential" || value === "secret" ? value : "internal";
}

function normalizePlan(value: unknown): Identity["plan"] {
  return value === "free" || value === "pro" ||
    value === "sovereign" || value === "gov" ? value : undefined;
}

async function keyFingerprint(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyAccessJWT(jwt: string, env: Env): Promise<any | null> {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3 || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
    const [h, p, s] = parts;
    const b64 = (x: string) => x.replace(/-/g, "+").replace(/_/g, "/");
    const header = JSON.parse(atob(b64(h)));
    const payload = JSON.parse(atob(b64(p)));

    // Cloudflare Access JWTs must be RS256, correctly scoped, and time-valid.
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
    if (typeof payload.nbf === "number" && payload.nbf * 1000 > Date.now()) return null;
    const audiences = Array.isArray(payload.aud)
      ? payload.aud
      : typeof payload.aud === "string" ? [payload.aud] : [];
    if (!audiences.includes(env.ACCESS_AUD)) return null;

    const iss = `https://${env.ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`;
    if (payload.iss !== iss) return null;
    const certResponse = await fetch(`${iss}/cdn-cgi/access/certs`);
    if (!certResponse.ok) return null;
    const certs = await certResponse.json() as { keys?: JsonWebKey[] };
    const jwk = certs.keys?.find((key: any) => key.kid === header.kid);
    if (!jwk) return null;

    const ck = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
    );
    const sig = Uint8Array.from(atob(b64(s)), (c) => c.charCodeAt(0));
    const data = new TextEncoder().encode(`${h}.${p}`);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", ck, sig, data))) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function authenticate(req: Request, env: Env): Promise<Identity | null> {
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) {
    const p = await verifyAccessJWT(jwt, env);
    if (p) {
      const email = typeof p.email === "string" ? p.email.slice(0, 200) : "access-user";
      return {
        actor: email,
        method: "access",
        tenant: resolveTenantClaim(p.custom?.tenant, await keyFingerprint(email)),
        roles: normalizeRoles(p.custom?.roles),
        clearance: normalizeClearance(p.custom?.clearance),
        plan: normalizePlan(p.custom?.plan),
      };
    }
  }

  const authorization = req.headers.get("Authorization") ?? "";
  const key = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (env.API_KEY && key && timingSafeEqual(key, env.API_KEY)) {
    const fingerprint = await keyFingerprint(key);
    return {
      actor: `service:${fingerprint}`,
      method: "apikey",
      // A shared API key is a machine credential, never a human operator identity.
      // It receives no tenant assignment or privileged role by default.
      tenant: `unassigned-machine-${fingerprint}`,
      roles: ["service"],
      clearance: "internal",
    };
  }

  // Sensor credentials share the API secret but receive a non-privileged role.
  const sensorKey = req.headers.get("X-Sensor-Key");
  if (env.API_KEY && sensorKey && timingSafeEqual(sensorKey, env.API_KEY)) {
    return {
      actor: "lb-sensor",
      method: "sensor",
      tenant: "unassigned-sensor",
      roles: ["sensor"],
      clearance: "internal",
    };
  }
  return null;
}

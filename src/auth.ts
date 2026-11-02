import type { Env, Identity } from "./types";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function verifyAccessJWT(jwt: string, env: Env): Promise<any | null> {
  try {
    const [h, p, s] = jwt.split(".");
    const b64 = (x: string) => x.replace(/-/g, "+").replace(/_/g, "/");
    const header = JSON.parse(atob(b64(h)));
    const payload = JSON.parse(atob(b64(p)));
    if (payload.exp * 1000 < Date.now()) return null;
    if (env.ACCESS_AUD && !(payload.aud ?? []).includes(env.ACCESS_AUD)) return null;
    const iss = `https://${env.ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`;
    if (payload.iss !== iss) return null;
    const certs = (await (await fetch(`${iss}/cdn-cgi/access/certs`)).json()) as any;
    const jwk = certs.keys.find((k: any) => k.kid === header.kid);
    if (!jwk) return null;
    const ck = await crypto.subtle.importKey("jwk", jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(b64(s)), (c) => c.charCodeAt(0));
    const data = new TextEncoder().encode(`${h}.${p}`);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", ck, sig, data))) return null;
    return payload;
  } catch { return null; }
}

export async function authenticate(req: Request, env: Env): Promise<Identity | null> {
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) {
    const p = await verifyAccessJWT(jwt, env);
    if (p) return {
      actor: p.email ?? "access-user",
      method: "access",
      tenant: p.custom?.tenant ?? "default",
      roles: p.custom?.roles ?? ["viewer"],
      clearance: (p.custom?.clearance ?? "internal") as Identity["clearance"],
    };
  }
  const h = req.headers.get("Authorization") ?? "";
  const key = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (env.API_KEY && timingSafeEqual(key, env.API_KEY)) {
    return { actor: `apikey:${key.slice(0, 8)}…`, method: "apikey",
      tenant: "default", roles: ["admin", "executor"], clearance: "confidential" };
  }
  // Sensor interno (Load Balancing / webhooks)
  const sensorKey = req.headers.get("X-Sensor-Key");
  if (env.API_KEY && sensorKey && timingSafeEqual(sensorKey, env.API_KEY)) {
    return { actor: "lb-sensor", method: "sensor",
      tenant: "ops", roles: ["sensor"], clearance: "secret" };
  }
  return null;
}

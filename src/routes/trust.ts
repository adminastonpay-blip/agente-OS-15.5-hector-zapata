import type { Env, Identity } from "../types";
import { verifyPassport, type DecisionPassport } from "../trust/hmac-passport";
import { getCertificate } from "../provenance/certificate";
import { canAccessTenant } from "../lib/identity";

export async function handleTrust(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
  if (path === "/v1/trust/verify" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const passport = body.passport as DecisionPassport | undefined;
    if (!passport || typeof passport !== "object") {
      return json({ ok: false, error: "passport object required" }, 400);
    }
    if (!canAccessTenant(identity, passport.tenant || "default") && identity.method === "public") {
      // Public may verify integrity of a passport blob they hold (cryptographic check only)
    }
    const result = await verifyPassport(env, passport);
    return json({
      ok: result.ok,
      reason: result.reason,
      decision_id: passport.decision_id,
      kid: passport.kid,
      protocol: "DecisionPassport-v1",
    });
  }

  if (path === "/v1/trust/certificate" && req.method === "GET") {
    const u = new URL(req.url);
    const id = u.searchParams.get("id") || "";
    if (!id) return json({ ok: false, error: "id required" }, 400);
    const tenant = identity.tenant || "default";
    const cert = await getCertificate(env, tenant, id);
    if (!cert) return json({ ok: false, error: "not found" }, 404);
    if (!canAccessTenant(identity, cert.tenant)) {
      return json({ ok: false, error: "tenant_forbidden" }, 403);
    }
    let passport_ok: boolean | null = null;
    if (cert.passport) {
      const v = await verifyPassport(env, cert.passport);
      passport_ok = v.ok;
    }
    return json({ ok: true, certificate: cert, passport_ok });
  }

  if (path === "/v1/trust/status" && req.method === "GET") {
    const hasSecret = !!(env.PII_HMAC_SECRET || env.API_KEY);
    return json({
      ok: true,
      layer: "ASTON Trust",
      passport: "DecisionPassport-v1 HMAC-SHA256",
      signing_secret_configured: hasSecret,
      endpoints: {
        verify: "POST /v1/trust/verify",
        certificate: "GET /v1/trust/certificate?id=",
      },
      security: {
        public_tenant_spoofing: "closed",
        validate_endpoint: "auth_required_stub",
      },
    });
  }

  return null;
}

import type { Env, Identity } from "../types";
import { verifyPassport, type DecisionPassport } from "../trust/hmac-passport";
import { getCertificate } from "../provenance/certificate";
import { canAccessTenant } from "../lib/identity";
import { runTrustE2E } from "../trust/e2e-demo";
import { defaultConstitution, evaluateConstitution } from "../trust/constitution";

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
      layer: "ASTON Trust Infrastructure",
      spec: "ATI-2.0",
      passport: "DecisionPassport-v1 HMAC-SHA256",
      signing_secret_configured: hasSecret,
      endpoints: {
        verify: "POST /v1/trust/verify",
        certificate: "GET /v1/trust/certificate?id=",
        e2e: "POST /v1/trust/e2e",
        constitution: "POST /v1/trust/constitution/evaluate",
      },
      security: {
        public_tenant_spoofing: "closed",
        validate_endpoint: "auth_required_stub",
      },
      oceans: {
        zero_trust_edge: "partial",
        algorithmic_provenance: "partial",
        stateful_micro_edge: "partial",
        sovereign_economic: "partial",
      },
      not_claimed: ["opentimestamps_confirmed", "quantum_resistance", "zk_selective_disclosure"],
    });
  }

  if (path === "/v1/trust/e2e" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const result = await runTrustE2E(env, identity, body);
    return json(result, result.ok ? 200 : 403);
  }

  if (path === "/v1/trust/constitution/evaluate" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const agent_id = String(body.agent_id || identity.actor || "agent").slice(0, 64);
    const c = defaultConstitution(agent_id, identity.tenant, body.overrides);
    const v = evaluateConstitution(c, {
      action: String(body.action || "read"),
      object_type: String(body.object_type || "report"),
      estimated_exposure: Number(body.estimated_exposure) || 0,
      estimated_cost: Number(body.estimated_cost) || 0,
      model: body.model,
      used_calls: Number(body.used_calls) || 0,
    });
    return json({ ok: true, constitution: c, verdict: v });
  }

  return null;
}

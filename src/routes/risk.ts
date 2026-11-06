import type { Env, Identity } from "../types";
import {
  computeArr,
  defaultEnvelope,
  envelopeAllows,
  quotePolicy,
  type RiskEnvelope,
  type ArrResult,
} from "../risk/arr";
import { recordDecision } from "../provenance/replay";
import { getPassport } from "../economy/reputation";

async function saveEnvelope(env: Env, e: RiskEnvelope) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS risk_envelopes (
        agent_id TEXT PRIMARY KEY,
        tenant TEXT,
        payload TEXT,
        updated_at INTEGER
      )`
    ).run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO risk_envelopes (agent_id, tenant, payload, updated_at) VALUES (?, ?, ?, ?)`
    )
      .bind(e.agent_id, e.tenant, JSON.stringify(e), e.updated_at)
      .run();
  } catch (err) {
    console.error("[ENVELOPE]", String(err));
  }
}

async function loadEnvelope(
  env: Env,
  tenant: string,
  agent_id: string
): Promise<RiskEnvelope | null> {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT payload FROM risk_envelopes WHERE agent_id = ? AND tenant = ?`
    )
      .bind(agent_id, tenant)
      .first<{ payload: string }>();
    if (!row?.payload) return null;
    return JSON.parse(row.payload) as RiskEnvelope;
  } catch {
    return null;
  }
}

async function savePolicy(env: Env, policy: ReturnType<typeof quotePolicy>) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS risk_policies (
        id TEXT PRIMARY KEY,
        tenant TEXT,
        payload TEXT,
        issued_at INTEGER
      )`
    ).run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO risk_policies (id, tenant, payload, issued_at) VALUES (?, ?, ?, ?)`
    )
      .bind(policy.policy_id, policy.tenant, JSON.stringify(policy), policy.issued_at)
      .run();
  } catch (e) {
    console.error("[POLICY]", String(e));
  }
}

export async function handleRisk(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
  // Pure ARR score
  if (path === "/v1/risk/score" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const arr = computeArr({
      evidence_count: Number(body.evidence_count ?? body.evidence?.length ?? 0),
      evidence_hashes: body.evidence_hashes,
      data_freshness_hours: body.data_freshness_hours,
      action_risk_score: body.action_risk_score,
      agent_trust_score: body.agent_trust_score,
      impact_depth: body.impact_depth,
      reversible: body.reversible,
      human_approved: body.human_approved,
      exposure_usd: body.exposure_usd,
      domain: body.domain,
    });
    return json({ ok: true, protocol: "ARR-v0", ...arr });
  }

  // Full: score + optional provenance + policy quote + envelope gate
  if (path === "/v1/risk/underwrite" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const question = String(body.question || body.message || "").trim();
    if (!question) return json({ ok: false, error: "question required" }, 400);

    const agent_id = String(body.agent_id || "default-agent").slice(0, 64);
    const exposure_usd = Number(body.exposure_usd) || 0;
    const tenant = identity.tenant || "default";

    let agent_trust_score = Number(body.agent_trust_score) || 50;
    try {
      const passport = await getPassport(env, tenant, agent_id);
      if (passport) agent_trust_score = passport.trust_score;
    } catch {
      /* optional */
    }

    const arr = computeArr({
      evidence_count: Array.isArray(body.evidence) ? body.evidence.length : Number(body.evidence_count) || 0,
      data_freshness_hours: body.data_freshness_hours,
      action_risk_score: body.action_risk_score,
      agent_trust_score,
      impact_depth: body.impact_depth,
      reversible: body.reversible !== false,
      human_approved: !!body.human_approved,
      exposure_usd,
      domain: body.domain || "logistics",
    });

    let envelope =
      (await loadEnvelope(env, tenant, agent_id)) ||
      defaultEnvelope(agent_id, tenant, body.domain || "logistics");
    if (body.envelope) {
      envelope = { ...envelope, ...body.envelope, agent_id, tenant, updated_at: Date.now() };
      await saveEnvelope(env, envelope);
    }

    const gate = envelopeAllows(envelope, arr, exposure_usd);
    const policy = quotePolicy(tenant, arr, {
      agent_id,
      exposure_usd: exposure_usd || arr.max_exposure,
    });

    let package_id: string | undefined;
    let certificate: unknown;
    if (body.record !== false) {
      try {
        const pkg = await recordDecision(env, identity, {
          question,
          evidence: body.evidence,
          data_snapshot: {
            ...(body.data_snapshot || {}),
            arr_score: arr.arr_score,
            risk_band: arr.risk_band,
            exposure_usd,
          },
          agent_id,
          human_approver: body.human_approver,
          outcome: body.outcome,
          run_model: body.run_model === true,
        });
        package_id = pkg.package_id;
        certificate = pkg.certificate;
        policy.decision_id = pkg.certificate?.decision_id || pkg.package_id;
      } catch (e: any) {
        console.error("[UNDERWRITE_RECORD]", String(e?.message || e));
      }
    }

    if (gate.allowed && exposure_usd > 0) {
      envelope.used_exposure_usd += exposure_usd;
      envelope.used_decisions += 1;
      envelope.updated_at = Date.now();
      await saveEnvelope(env, envelope);
    }

    await savePolicy(env, policy);

    return json({
      ok: true,
      protocol: "ARR-v0",
      category: "Decision Risk Exchange",
      arr,
      envelope: {
        agent_id: envelope.agent_id,
        max_exposure_usd: envelope.max_exposure_usd,
        used_exposure_usd: envelope.used_exposure_usd,
        min_arr_score: envelope.min_arr_score,
        used_decisions: envelope.used_decisions,
      },
      gate,
      policy,
      package_id,
      certificate,
      execution:
        gate.allowed
          ? "allowed_within_envelope"
          : "blocked_or_needs_approval",
      note: "Simulated underwriting — capital markets integration is a later phase",
    });
  }

  if (path === "/v1/risk/envelope" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const agent_id = String(body.agent_id || "").slice(0, 64);
    if (!agent_id) return json({ ok: false, error: "agent_id required" }, 400);
    const tenant = identity.tenant || "default";
    const base = (await loadEnvelope(env, tenant, agent_id)) || defaultEnvelope(agent_id, tenant);
    const envelope: RiskEnvelope = {
      ...base,
      max_exposure_usd: Number(body.max_exposure_usd) || base.max_exposure_usd,
      max_decisions_per_day: Number(body.max_decisions_per_day) || base.max_decisions_per_day,
      min_arr_score: Number(body.min_arr_score) || base.min_arr_score,
      domain: body.domain || base.domain,
      updated_at: Date.now(),
    };
    await saveEnvelope(env, envelope);
    return json({ ok: true, envelope });
  }

  if (path === "/v1/risk/envelope" && req.method === "GET") {
    const u = new URL(req.url);
    const agent_id = u.searchParams.get("agent_id") || "";
    if (!agent_id) return json({ ok: false, error: "agent_id required" }, 400);
    const e =
      (await loadEnvelope(env, identity.tenant || "default", agent_id)) ||
      defaultEnvelope(agent_id, identity.tenant || "default");
    return json({ ok: true, envelope: e, persisted: !!(await loadEnvelope(env, identity.tenant || "default", agent_id)) });
  }

  if (path === "/v1/risk/status" && req.method === "GET") {
    return json({
      ok: true,
      exchange: "Decision Risk Exchange",
      protocol: "ARR-v0",
      tagline:
        "Clearing house for the agent economy — measurable, insured, governable decision risk",
      endpoints: {
        score: "POST /v1/risk/score",
        underwrite: "POST /v1/risk/underwrite",
        envelope: "POST|GET /v1/risk/envelope",
      },
      products: [
        "Risk Score API",
        "Agent Underwriting",
        "Risk Envelopes",
        "Quoted Insurance Policy",
        "ARR Registry (via reputation + envelopes)",
      ],
    });
  }

  return null;
}

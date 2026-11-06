/**
 * Risk Envelope v1 — operational exposure limits per agent.
 * Connects ARR scores to governed execution.
 */
import type { Env } from "../types";
import {
  computeArr,
  defaultEnvelope,
  envelopeAllows,
  type RiskEnvelope,
  type ArrResult,
  type RiskInputs,
} from "./arr";

export type { RiskEnvelope, ArrResult };
export { computeArr, defaultEnvelope, envelopeAllows };

export async function saveEnvelope(env: Env, e: RiskEnvelope): Promise<void> {
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
    console.error("[ENVELOPE_SAVE]", String(err));
  }
}

export async function loadEnvelope(
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

export async function listEnvelopes(env: Env, tenant: string): Promise<RiskEnvelope[]> {
  if (!env.DB) return [];
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS risk_envelopes (
        agent_id TEXT PRIMARY KEY,
        tenant TEXT,
        payload TEXT,
        updated_at INTEGER
      )`
    ).run();
    const rows = await env.DB.prepare(
      `SELECT payload FROM risk_envelopes WHERE tenant = ? ORDER BY updated_at DESC LIMIT 100`
    )
      .bind(tenant)
      .all();
    return (rows.results || [])
      .map((r: any) => {
        try {
          return JSON.parse(r.payload) as RiskEnvelope;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as RiskEnvelope[];
  } catch {
    return [];
  }
}

export async function saveAssessment(
  env: Env,
  tenant: string,
  assessment: Record<string, unknown>
): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS risk_assessments (
        id TEXT PRIMARY KEY,
        tenant TEXT,
        agent_id TEXT,
        payload TEXT,
        created_at INTEGER
      )`
    ).run();
    await env.DB.prepare(
      `INSERT INTO risk_assessments (id, tenant, agent_id, payload, created_at) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        String(assessment.id),
        tenant,
        String(assessment.agent_id || ""),
        JSON.stringify(assessment),
        Date.now()
      )
      .run();
  } catch (e) {
    console.error("[ASSESS_SAVE]", String(e));
  }
}

export async function assessDecision(
  env: Env,
  tenant: string,
  input: RiskInputs & {
    agent_id?: string;
    estimated_exposure?: number;
  }
): Promise<{
  assessment_id: string;
  arr: ArrResult;
  envelope: RiskEnvelope;
  gate: { allowed: boolean; reasons: string[] };
  rule: string;
}> {
  const agent_id = (input.agent_id || "default-agent").slice(0, 64);
  const exposure = Number(input.estimated_exposure ?? input.exposure_usd ?? 0);
  const arr = computeArr({ ...input, exposure_usd: exposure });
  let envelope =
    (await loadEnvelope(env, tenant, agent_id)) ||
    defaultEnvelope(agent_id, tenant, input.domain || "logistics");

  const gate = envelopeAllows(envelope, arr, exposure);
  // Core rule from protocol
  if (exposure > envelope.max_exposure_usd && !gate.reasons.includes("exposure_cap")) {
    gate.reasons.push("exposure_cap");
    (gate as any).allowed = false;
  }

  const assessment_id = `ra_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await saveAssessment(env, tenant, {
    id: assessment_id,
    agent_id,
    arr,
    envelope_snapshot: {
      max_exposure_usd: envelope.max_exposure_usd,
      used_exposure_usd: envelope.used_exposure_usd,
      min_arr_score: envelope.min_arr_score,
    },
    estimated_exposure: exposure,
    gate,
  });

  return {
    assessment_id,
    arr,
    envelope,
    gate: { allowed: gate.allowed, reasons: gate.reasons },
    rule: "if estimated_exposure > max_exposure → require_approval or deny",
  };
}

/** Used by governed agents executePlan */
export async function gateAgentExposure(
  env: Env,
  tenant: string,
  agent_id: string,
  estimated_exposure: number
): Promise<{ allowed: boolean; reasons: string[]; arr: ArrResult; envelope: RiskEnvelope }> {
  const result = await assessDecision(env, tenant, {
    agent_id,
    estimated_exposure,
    exposure_usd: estimated_exposure,
    evidence_count: 1,
    reversible: true,
  });
  return {
    allowed: result.gate.allowed,
    reasons: result.gate.reasons,
    arr: result.arr,
    envelope: result.envelope,
  };
}

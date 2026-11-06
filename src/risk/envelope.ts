/**
 * Risk Envelope v1.1
 * - Composite tenant+agent isolation
 * - Cumulative exposure accounting
 * - require_approval vs deny
 * - Admin-only envelope mutation
 * - Non-negative finite exposure
 * - UTC daily decision counter reset
 */
import type { Env, Identity } from "../types";
import {
  computeArr,
  defaultEnvelope,
  type RiskEnvelope,
  type ArrResult,
  type RiskInputs,
} from "./arr";

export type { RiskEnvelope, ArrResult };
export { computeArr, defaultEnvelope };

export type GateVerdict = "allow" | "require_approval" | "deny";

export function sanitizeExposure(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

function utcDay(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Reset daily counters if calendar day (UTC) changed. */
export function refreshDailyCounters(e: RiskEnvelope): RiskEnvelope {
  const day = utcDay();
  const last = (e as any).usage_day as string | undefined;
  if (last === day) return e;
  return {
    ...e,
    used_decisions: 0,
    // keep used_exposure_usd as lifetime/period exposure unless product says otherwise
    updated_at: Date.now(),
    ...( { usage_day: day } as any),
  };
}

export async function saveEnvelope(env: Env, e: RiskEnvelope): Promise<void> {
  if (!env.DB) return;
  const payload = JSON.stringify(refreshDailyCounters(e));
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS risk_envelopes_v2 (
        tenant TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant, agent_id)
      )`
    ).run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO risk_envelopes_v2 (tenant, agent_id, payload, updated_at) VALUES (?, ?, ?, ?)`
    )
      .bind(e.tenant, e.agent_id, payload, Date.now())
      .run();
  } catch (err) {
    console.error("[ENVELOPE_SAVE_V2]", String(err));
  }
}

export async function loadEnvelope(
  env: Env,
  tenant: string,
  agent_id: string
): Promise<RiskEnvelope | null> {
  if (!env.DB) return null;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS risk_envelopes_v2 (
        tenant TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant, agent_id)
      )`
    ).run();
    const row = await env.DB.prepare(
      `SELECT payload FROM risk_envelopes_v2 WHERE tenant = ? AND agent_id = ?`
    )
      .bind(tenant, agent_id)
      .first<{ payload: string }>();
    if (row?.payload) {
      return refreshDailyCounters(JSON.parse(row.payload) as RiskEnvelope);
    }
  } catch {
    /* fall through to legacy */
  }
  // Legacy single-key table (tenant collision risk) — only if agent_id unique match
  try {
    const legacy = await env.DB.prepare(
      `SELECT payload, tenant FROM risk_envelopes WHERE agent_id = ?`
    )
      .bind(agent_id)
      .first<{ payload: string; tenant?: string }>();
    if (legacy?.payload) {
      const parsed = JSON.parse(legacy.payload) as RiskEnvelope;
      if (!legacy.tenant || legacy.tenant === tenant || parsed.tenant === tenant) {
        return refreshDailyCounters({ ...parsed, tenant, agent_id });
      }
    }
  } catch {
    /* none */
  }
  return null;
}

export async function listEnvelopes(env: Env, tenant: string): Promise<RiskEnvelope[]> {
  if (!env.DB) return [];
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS risk_envelopes_v2 (
        tenant TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant, agent_id)
      )`
    ).run();
    const rows = await env.DB.prepare(
      `SELECT payload FROM risk_envelopes_v2 WHERE tenant = ? ORDER BY updated_at DESC LIMIT 100`
    )
      .bind(tenant)
      .all();
    return (rows.results || [])
      .map((r: any) => {
        try {
          return refreshDailyCounters(JSON.parse(r.payload) as RiskEnvelope);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as RiskEnvelope[];
  } catch {
    return [];
  }
}

export function isAdmin(identity: Identity): boolean {
  return (
    identity.method === "apikey" ||
    identity.roles.includes("admin") ||
    identity.roles.includes("executor")
  );
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

/**
 * Gate a proposed exposure against envelope + ARR.
 * humanApproved: plan already human-approved → require_approval becomes allow.
 */
export function evaluateGate(
  envelope: RiskEnvelope,
  arr: ArrResult,
  proposed_exposure: number,
  opts: { humanApproved?: boolean; cumulative_exposure?: number } = {}
): { verdict: GateVerdict; allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const exposure = sanitizeExposure(proposed_exposure);
  const cumulative = sanitizeExposure(opts.cumulative_exposure ?? 0) + exposure;

  if (arr.arr_score < envelope.min_arr_score) reasons.push("arr_below_minimum");
  if (envelope.used_decisions >= envelope.max_decisions_per_day) reasons.push("daily_decision_cap");

  if (envelope.used_exposure_usd + exposure > envelope.max_exposure_usd) {
    reasons.push("exposure_cap");
  }
  if (cumulative > envelope.max_exposure_usd) {
    reasons.push("plan_cumulative_exposure_cap");
  }
  if (exposure > arr.max_exposure) reasons.push("exceeds_arr_max_exposure");

  const needsHuman =
    arr.required_approvals > 0 ||
    reasons.includes("exposure_cap") ||
    reasons.includes("plan_cumulative_exposure_cap") ||
    reasons.includes("exceeds_arr_max_exposure") ||
    arr.risk_band === "elevated" ||
    arr.risk_band === "critical";

  if (reasons.includes("arr_below_minimum") && arr.arr_score < envelope.min_arr_score - 20) {
    return { verdict: "deny", allowed: false, reasons: [...reasons, "arr_hard_floor"] };
  }
  if (reasons.includes("daily_decision_cap")) {
    return { verdict: "deny", allowed: false, reasons };
  }

  if (needsHuman) {
    if (opts.humanApproved) {
      return {
        verdict: "allow",
        allowed: true,
        reasons: [...reasons, "human_approved_override"],
      };
    }
    return {
      verdict: "require_approval",
      allowed: false,
      reasons: [...reasons, `requires_${Math.max(1, arr.required_approvals)}_human_approvals`],
    };
  }

  if (reasons.length) {
    return { verdict: "require_approval", allowed: false, reasons };
  }
  return { verdict: "allow", allowed: true, reasons: [] };
}

export async function assessDecision(
  env: Env,
  tenant: string,
  input: RiskInputs & {
    agent_id?: string;
    estimated_exposure?: number;
    human_approved?: boolean;
    cumulative_exposure?: number;
  }
): Promise<{
  assessment_id: string;
  arr: ArrResult;
  envelope: RiskEnvelope;
  gate: { verdict: GateVerdict; allowed: boolean; reasons: string[] };
  rule: string;
}> {
  const agent_id = (input.agent_id || "default-agent").slice(0, 64);
  const exposure = sanitizeExposure(input.estimated_exposure ?? input.exposure_usd ?? 0);
  const arr = computeArr({ ...input, exposure_usd: exposure });
  let envelope =
    (await loadEnvelope(env, tenant, agent_id)) ||
    defaultEnvelope(agent_id, tenant, input.domain || "logistics");
  envelope = refreshDailyCounters(envelope);

  const gate = evaluateGate(envelope, arr, exposure, {
    humanApproved: !!input.human_approved,
    cumulative_exposure: input.cumulative_exposure,
  });

  const assessment_id = `ra_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await saveAssessment(env, tenant, {
    id: assessment_id,
    agent_id,
    arr,
    envelope_snapshot: {
      max_exposure_usd: envelope.max_exposure_usd,
      used_exposure_usd: envelope.used_exposure_usd,
      min_arr_score: envelope.min_arr_score,
      used_decisions: envelope.used_decisions,
    },
    estimated_exposure: exposure,
    gate,
  });

  return {
    assessment_id,
    arr,
    envelope,
    gate,
    rule: "if exposure > envelope.max → require_approval; human-approved plan may proceed; hard deny on daily cap / arr floor",
  };
}

export async function gateAgentExposure(
  env: Env,
  tenant: string,
  agent_id: string,
  estimated_exposure: number,
  opts: { humanApproved?: boolean; cumulative_exposure?: number } = {}
): Promise<{
  verdict: GateVerdict;
  allowed: boolean;
  reasons: string[];
  arr: ArrResult;
  envelope: RiskEnvelope;
}> {
  const result = await assessDecision(env, tenant, {
    agent_id,
    estimated_exposure: sanitizeExposure(estimated_exposure),
    exposure_usd: sanitizeExposure(estimated_exposure),
    evidence_count: 1,
    reversible: true,
    human_approved: opts.humanApproved,
    cumulative_exposure: opts.cumulative_exposure,
  });
  return {
    verdict: result.gate.verdict,
    allowed: result.gate.allowed,
    reasons: result.gate.reasons,
    arr: result.arr,
    envelope: result.envelope,
  };
}

/** Consume exposure after a successful step execution. */
export async function consumeExposure(
  env: Env,
  tenant: string,
  agent_id: string,
  exposure: number
): Promise<RiskEnvelope | null> {
  const amount = sanitizeExposure(exposure);
  if (amount <= 0) return loadEnvelope(env, tenant, agent_id);
  let e =
    (await loadEnvelope(env, tenant, agent_id)) || defaultEnvelope(agent_id, tenant);
  e = refreshDailyCounters(e);
  e.used_exposure_usd = sanitizeExposure(e.used_exposure_usd) + amount;
  e.used_decisions = (e.used_decisions || 0) + 1;
  e.updated_at = Date.now();
  (e as any).usage_day = utcDay();
  await saveEnvelope(env, e);
  return e;
}

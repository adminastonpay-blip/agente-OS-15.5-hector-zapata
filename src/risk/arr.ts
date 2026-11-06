/**
 * ARR — Aston Risk Rating
 * Deterministic actuarial-style score for autonomous decisions.
 * Higher score = safer / lower risk (0-100).
 */

export type RiskBand = "minimal" | "low" | "moderate" | "elevated" | "critical";

export interface RiskInputs {
  evidence_count: number;
  evidence_hashes?: string[];
  data_freshness_hours?: number; // null/undefined = unknown
  action_risk_score?: number; // 0-100 from SafetyInterlock policy
  agent_trust_score?: number; // 0-100 from reputation passport
  impact_depth?: number; // cascade depth
  reversible?: boolean;
  human_approved?: boolean;
  exposure_usd?: number;
  domain?: string;
}

export interface ArrResult {
  arr_score: number;
  risk_band: RiskBand;
  max_exposure: number;
  required_approvals: number;
  premium_bps: number;
  coverage: {
    reversal_window_hours: number;
    max_liability: number;
  };
  signals: Record<string, number | string | boolean>;
  reasons: string[];
}

function clamp(n: number, a = 0, b = 100) {
  return Math.max(a, Math.min(b, n));
}

export function computeArr(inputs: RiskInputs): ArrResult {
  const reasons: string[] = [];
  let score = 55; // neutral base

  // Evidence quality
  const ev = inputs.evidence_count || 0;
  if (ev >= 3) {
    score += 12;
    reasons.push("strong_evidence");
  } else if (ev >= 1) {
    score += 6;
    reasons.push("some_evidence");
  } else {
    score -= 15;
    reasons.push("no_evidence");
  }

  // Freshness
  const fresh = inputs.data_freshness_hours;
  if (fresh === undefined || fresh === null) {
    score -= 5;
    reasons.push("freshness_unknown");
  } else if (fresh <= 1) {
    score += 10;
    reasons.push("fresh_data");
  } else if (fresh <= 24) {
    score += 4;
  } else if (fresh > 168) {
    score -= 12;
    reasons.push("stale_data");
  }

  // Safety / action risk (higher action risk lowers ARR)
  const actionRisk = inputs.action_risk_score ?? 30;
  score -= Math.round(actionRisk * 0.25);
  if (actionRisk >= 70) reasons.push("high_action_risk");

  // Agent history
  const trust = inputs.agent_trust_score ?? 50;
  score += Math.round((trust - 50) * 0.2);
  if (trust >= 75) reasons.push("trusted_agent");
  if (trust < 30) reasons.push("low_trust_agent");

  // Cascade impact
  const depth = inputs.impact_depth ?? 0;
  if (depth >= 4) {
    score -= 15;
    reasons.push("deep_cascade");
  } else if (depth >= 2) {
    score -= 7;
    reasons.push("moderate_cascade");
  }

  // Reversibility
  if (inputs.reversible === true) {
    score += 8;
    reasons.push("reversible");
  } else if (inputs.reversible === false) {
    score -= 12;
    reasons.push("irreversible");
  }

  // Human approval already present
  if (inputs.human_approved) {
    score += 10;
    reasons.push("human_approved");
  }

  // Exposure pressure
  const exposure = Math.max(0, inputs.exposure_usd ?? 0);
  if (exposure >= 100_000) {
    score -= 15;
    reasons.push("high_exposure");
  } else if (exposure >= 25_000) {
    score -= 8;
    reasons.push("medium_exposure");
  }

  score = clamp(Math.round(score));

  const risk_band: RiskBand =
    score >= 85
      ? "minimal"
      : score >= 70
        ? "low"
        : score >= 50
          ? "moderate"
          : score >= 30
            ? "elevated"
            : "critical";

  // Max exposure envelope from band + trust
  const baseCap =
    risk_band === "minimal"
      ? 100_000
      : risk_band === "low"
        ? 50_000
        : risk_band === "moderate"
          ? 25_000
          : risk_band === "elevated"
            ? 5_000
            : 500;
  const trustMult = 0.5 + trust / 100;
  const max_exposure = Math.round(baseCap * trustMult);

  const required_approvals =
    risk_band === "critical" || risk_band === "elevated" || exposure > max_exposure
      ? risk_band === "critical"
        ? 2
        : 1
      : 0;

  // Premium in basis points (inverse to score)
  const premium_bps = clamp(Math.round(120 - score), 5, 250);

  const reversal_window_hours =
    risk_band === "minimal" || risk_band === "low" ? 48 : risk_band === "moderate" ? 24 : 12;

  return {
    arr_score: score,
    risk_band,
    max_exposure,
    required_approvals,
    premium_bps,
    coverage: {
      reversal_window_hours,
      max_liability: max_exposure,
    },
    signals: {
      evidence_count: ev,
      action_risk: actionRisk,
      agent_trust: trust,
      impact_depth: depth,
      exposure_usd: exposure,
      reversible: !!inputs.reversible,
      human_approved: !!inputs.human_approved,
      domain: inputs.domain || "general",
    },
    reasons,
  };
}

export interface RiskEnvelope {
  agent_id: string;
  tenant: string;
  domain: string;
  max_exposure_usd: number;
  max_decisions_per_day: number;
  min_arr_score: number;
  used_exposure_usd: number;
  used_decisions: number;
  updated_at: number;
}

export function defaultEnvelope(
  agent_id: string,
  tenant: string,
  domain = "logistics"
): RiskEnvelope {
  return {
    agent_id,
    tenant,
    domain,
    max_exposure_usd: 25_000,
    max_decisions_per_day: 50,
    min_arr_score: 50,
    used_exposure_usd: 0,
    used_decisions: 0,
    updated_at: Date.now(),
  };
}

export function envelopeAllows(
  envl: RiskEnvelope,
  arr: ArrResult,
  proposed_exposure: number
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (arr.arr_score < envl.min_arr_score) reasons.push("arr_below_minimum");
  if (envl.used_decisions >= envl.max_decisions_per_day) reasons.push("daily_decision_cap");
  if (envl.used_exposure_usd + proposed_exposure > envl.max_exposure_usd) {
    reasons.push("exposure_cap");
  }
  if (proposed_exposure > arr.max_exposure) reasons.push("exceeds_arr_max_exposure");
  if (arr.required_approvals > 0) reasons.push(`requires_${arr.required_approvals}_human_approvals`);
  return { allowed: reasons.length === 0, reasons };
}

export interface InsurancePolicy {
  policy_id: string;
  decision_id?: string;
  agent_id?: string;
  tenant: string;
  arr_score: number;
  risk_band: RiskBand;
  premium_usd: number;
  coverage_usd: number;
  reversal_window_hours: number;
  status: "quoted" | "active" | "claimed" | "expired";
  issued_at: number;
  expires_at: number;
}

export function quotePolicy(
  tenant: string,
  arr: ArrResult,
  opts: { decision_id?: string; agent_id?: string; exposure_usd?: number }
): InsurancePolicy {
  const coverage = Math.min(arr.max_exposure, opts.exposure_usd ?? arr.max_exposure);
  const premium_usd = Math.max(1, Math.round((coverage * arr.premium_bps) / 10_000 * 100) / 100);
  const now = Date.now();
  return {
    policy_id: `pol_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    decision_id: opts.decision_id,
    agent_id: opts.agent_id,
    tenant,
    arr_score: arr.arr_score,
    risk_band: arr.risk_band,
    premium_usd,
    coverage_usd: coverage,
    reversal_window_hours: arr.coverage.reversal_window_hours,
    status: "quoted",
    issued_at: now,
    expires_at: now + arr.coverage.reversal_window_hours * 3600 * 1000,
  };
}

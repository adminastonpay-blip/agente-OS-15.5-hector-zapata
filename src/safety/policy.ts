/**
 * Safety Policy Engine — Aston OS 15.5
 * Evalúa acciones propuestas por agentes y decide:
 *   - allow
 *   - require_approval (human-in-the-loop)
 *   - deny
 *
 * Combina riesgo (risk score) + ABAC (roles + clearance) + ontología.
 */

import type { Identity } from "../types";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type Decision = "allow" | "require_approval" | "deny";

export interface ProposedAction {
  tool: string;
  args: Record<string, unknown>;
  context?: {
    objective?: string;
    mission_id?: string;
    sim_id?: string;
    object_ids?: string[];
  };
}

export interface PolicyResult {
  decision: Decision;
  risk: RiskLevel;
  score: number;          // 0-100
  reasons: string[];
  requires_clearance?: string;
  expires_in_ms?: number; // para approvals temporales
}

const HIGH_RISK_TOOLS = new Set([
  "create_object",
  "create_link",
  "write",
  "apply_simulation_delta",
  "commit_simulation",
  "disable_pool",
  "failover",
  "isolate",
  "delete_object",
  "run_code",
  "exec",
]);

const CRITICAL_TOOLS = new Set([
  "disable_pool",
  "failover",
  "isolate",
  "commit_simulation",
  "delete_object",
]);

const CLEARANCE_RANK: Record<string, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3,
};

/**
 * Calcula score de riesgo (0-100) de una acción propuesta.
 */
export function scoreRisk(action: ProposedAction, identity: Identity): number {
  let score = 10; // base

  // Tool risk
  if (CRITICAL_TOOLS.has(action.tool)) score += 55;
  else if (HIGH_RISK_TOOLS.has(action.tool)) score += 35;
  else score += 5;

  // Args heuristics
  const argsStr = JSON.stringify(action.args).toLowerCase();
  if (argsStr.includes("delete") || argsStr.includes("drop") || argsStr.includes("destroy")) score += 20;
  if (argsStr.includes("production") || argsStr.includes("prod") || argsStr.includes("live")) score += 15;
  if (argsStr.includes("secret") || argsStr.includes("credential") || argsStr.includes("token")) score += 15;
  if (argsStr.includes("all") || argsStr.includes("*")) score += 10;

  // Context
  if (action.context?.mission_id) score += 10;
  if (action.context?.object_ids && action.context.object_ids.length > 20) score += 15;

  // Identity trust (lower clearance → higher risk)
  const clr = CLEARANCE_RANK[identity.clearance] ?? 0;
  if (clr < 2) score += 15;
  if (!identity.roles.includes("executor") && !identity.roles.includes("admin")) score += 10;

  return Math.min(100, Math.max(0, score));
}

function riskFromScore(score: number): RiskLevel {
  if (score >= 80) return "critical";
  if (score >= 55) return "high";
  if (score >= 30) return "medium";
  return "low";
}

/**
 * Evalúa la política completa.
 */
export function evaluatePolicy(
  action: ProposedAction,
  identity: Identity
): PolicyResult {
  const score = scoreRisk(action, identity);
  const risk = riskFromScore(score);
  const reasons: string[] = [];

  // Hard deny rules
  if (CRITICAL_TOOLS.has(action.tool) && identity.clearance !== "secret") {
    reasons.push(`Tool "${action.tool}" requiere clearance secret`);
    return {
      decision: "deny",
      risk,
      score,
      reasons,
      requires_clearance: "secret",
    };
  }

  if (
    (action.tool === "create_object" || action.tool === "create_link") &&
    !identity.roles.includes("executor") &&
    !identity.roles.includes("admin")
  ) {
    reasons.push("Rol insuficiente para modificar ontología");
    return { decision: "deny", risk, score, reasons };
  }

  // Require approval thresholds
  if (risk === "critical" || score >= 75) {
    reasons.push(`Riesgo ${risk} (score ${score}) — requiere aprobación humana`);
    return {
      decision: "require_approval",
      risk,
      score,
      reasons,
      expires_in_ms: 24 * 60 * 60 * 1000, // 24h
    };
  }

  if (risk === "high" || score >= 50) {
    if (identity.clearance === "secret" || identity.roles.includes("admin")) {
      reasons.push(`Riesgo alto pero clearance/roles suficientes — allow con auditoría reforzada`);
      return { decision: "allow", risk, score, reasons };
    }
    reasons.push(`Riesgo ${risk} (score ${score}) — requiere aprobación`);
    return {
      decision: "require_approval",
      risk,
      score,
      reasons,
      expires_in_ms: 4 * 60 * 60 * 1000, // 4h
    };
  }

  reasons.push(`Riesgo ${risk} (score ${score}) — permitido`);
  return { decision: "allow", risk, score, reasons };
}

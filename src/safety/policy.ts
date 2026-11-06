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
    role?: string;
  };
}

export interface PolicyResult {
  decision: Decision;
  risk: RiskLevel;
  score: number;
  reasons: string[];
  requires_clearance?: string;
  expires_in_ms?: number;
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
  "defense_mitigate",
  "code_certify",
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

export function scoreRisk(action: ProposedAction, identity: Identity): number {
  let score = 10;
  if (CRITICAL_TOOLS.has(action.tool)) score += 55;
  else if (HIGH_RISK_TOOLS.has(action.tool)) score += 35;
  else score += 5;

  const argsStr = JSON.stringify(action.args ?? {}).toLowerCase();
  if (argsStr.includes("delete") || argsStr.includes("drop") || argsStr.includes("destroy"))
    score += 20;
  if (argsStr.includes("production") || argsStr.includes("prod") || argsStr.includes("live"))
    score += 15;
  if (argsStr.includes("secret") || argsStr.includes("credential") || argsStr.includes("token"))
    score += 15;
  if (argsStr.includes("block_ip") || argsStr.includes("block_pattern")) score += 25;

  if (action.context?.mission_id) score += 10;
  if (action.context?.object_ids && action.context.object_ids.length > 20) score += 15;

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

export function evaluatePolicy(action: ProposedAction, identity: Identity): PolicyResult {
  const score = scoreRisk(action, identity);
  const risk = riskFromScore(score);
  const reasons: string[] = [];

  // Soft tools from defense observe/rate_limit
  if (action.tool === "defense_mitigate") {
    const mode = String(action.args?.mode || "");
    if (mode === "observe" || mode === "rate_limit") {
      reasons.push(`defense mode ${mode} — allow with audit`);
      return { decision: "allow", risk: "low", score: Math.min(score, 25), reasons };
    }
    if (mode === "block_ip" || mode === "block_pattern") {
      reasons.push("High-impact edge block requires human approval");
      return {
        decision: "require_approval",
        risk: "high",
        score: Math.max(score, 70),
        reasons,
        expires_in_ms: 4 * 60 * 60 * 1000,
      };
    }
  }

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

  if (risk === "critical" || score >= 75) {
    reasons.push(`Riesgo ${risk} (score ${score}) — requiere aprobación humana`);
    return {
      decision: "require_approval",
      risk,
      score,
      reasons,
      expires_in_ms: 24 * 60 * 60 * 1000,
    };
  }

  if (risk === "high" || score >= 50) {
    if (identity.clearance === "secret" || identity.roles.includes("admin")) {
      reasons.push(`Riesgo alto pero clearance/roles suficientes — allow`);
      return { decision: "allow", risk, score, reasons };
    }
    reasons.push(`Riesgo ${risk} (score ${score}) — requiere aprobación`);
    return {
      decision: "require_approval",
      risk,
      score,
      reasons,
      expires_in_ms: 4 * 60 * 60 * 1000,
    };
  }

  reasons.push(`Riesgo ${risk} (score ${score}) — permitido`);
  return { decision: "allow", risk, score, reasons };
}

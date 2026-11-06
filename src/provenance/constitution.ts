/**
 * Agent Constitution — executable governance profile for agents.
 */

export interface AgentConstitution {
  version: string;
  agent_id: string;
  objective: string;
  allowed_tools: string[];
  budget: {
    max_calls: number;
    max_cost_usdc: number;
    max_writes: number;
    max_wall_ms: number;
  };
  risk: {
    max_score: number;
    require_human_above: number;
  };
  evidence: {
    required: boolean;
    min_sources: number;
  };
  escalation: {
    human_roles: string[];
    veto_enabled: boolean;
    rollback_enabled: boolean;
  };
  created_at: number;
}

export const DEFAULT_CONSTITUTION: Omit<AgentConstitution, "agent_id" | "objective" | "created_at"> = {
  version: "1.0.0",
  allowed_tools: ["reason", "search", "graph_query"],
  budget: {
    max_calls: 20,
    max_cost_usdc: 1,
    max_writes: 5,
    max_wall_ms: 120_000,
  },
  risk: {
    max_score: 70,
    require_human_above: 50,
  },
  evidence: {
    required: true,
    min_sources: 1,
  },
  escalation: {
    human_roles: ["admin", "executor"],
    veto_enabled: true,
    rollback_enabled: true,
  },
};

export function buildConstitution(input: {
  agent_id: string;
  objective: string;
  allowed_tools?: string[];
  budget?: Partial<AgentConstitution["budget"]>;
  risk?: Partial<AgentConstitution["risk"]>;
}): AgentConstitution {
  return {
    ...DEFAULT_CONSTITUTION,
    agent_id: input.agent_id.slice(0, 64),
    objective: input.objective.slice(0, 500),
    allowed_tools: input.allowed_tools?.length
      ? input.allowed_tools.slice(0, 30)
      : DEFAULT_CONSTITUTION.allowed_tools,
    budget: { ...DEFAULT_CONSTITUTION.budget, ...input.budget },
    risk: { ...DEFAULT_CONSTITUTION.risk, ...input.risk },
    evidence: { ...DEFAULT_CONSTITUTION.evidence },
    escalation: { ...DEFAULT_CONSTITUTION.escalation },
    created_at: Date.now(),
  };
}

export function checkConstitution(
  c: AgentConstitution,
  usage: { calls: number; cost_usdc: number; writes: number; wall_ms: number; risk_score: number; tool: string }
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!c.allowed_tools.includes(usage.tool) && usage.tool !== "reason") {
    reasons.push(`tool_not_allowed:${usage.tool}`);
  }
  if (usage.calls > c.budget.max_calls) reasons.push("budget_calls");
  if (usage.cost_usdc > c.budget.max_cost_usdc) reasons.push("budget_cost");
  if (usage.writes > c.budget.max_writes) reasons.push("budget_writes");
  if (usage.wall_ms > c.budget.max_wall_ms) reasons.push("budget_time");
  if (usage.risk_score > c.risk.max_score) reasons.push("risk_max");
  return { ok: reasons.length === 0, reasons };
}

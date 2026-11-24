import type { Identity } from "../types";

export type TrustEffect = "allow" | "deny" | "require_approval";
export interface TrustRule {
  tool: string;
  effect: TrustEffect;
  required_roles: string[];
  enabled: boolean;
}
export interface TrustEvaluation {
  effect: TrustEffect;
  effective_roles: string[];
  matched_rule: string | null;
  reason: string;
}

const BUILTIN_ROLE_GRANTS: Record<string, string[]> = {
  admin: ["*"],
  executor: ["*"],
  recovery_diagnosis: ["recovery_diagnosis"],
  reader: ["read:*", "get:*", "list:*", "inspect:*", "status:*", "chat_completion"],
};

function roleAllows(role: string, tool: string): boolean {
  const grants = BUILTIN_ROLE_GRANTS[role] ?? [];
  return grants.some((grant) => grant === "*" || grant === tool ||
    (grant.endsWith(":*") && tool.startsWith(grant.slice(0, -1))));
}

/** Default-deny tenant RBAC. Risk scoring remains a separate, stricter policy layer. */
export function evaluateTrustAccess(
  identity: Identity,
  tool: string,
  tenantRoles: string[] = [],
  rules: TrustRule[] = [],
): TrustEvaluation {
  const effectiveRoles = [...new Set([...identity.roles, ...tenantRoles])].sort();
  const rule = rules.filter((item) => item.enabled && (item.tool === tool || item.tool === "*"))
    .sort((a, b) => a.tool === tool ? -1 : b.tool === tool ? 1 : 0)[0];
  if (rule) {
    const roleMatch = rule.required_roles.length === 0 ||
      rule.required_roles.some((role) => effectiveRoles.includes(role));
    if (!roleMatch) return { effect: "deny", effective_roles: effectiveRoles, matched_rule: rule.tool, reason: "trust_policy_role_mismatch" };
    return { effect: rule.effect, effective_roles: effectiveRoles, matched_rule: rule.tool, reason: "trust_policy_rule_match" };
  }
  const allowed = effectiveRoles.some((role) => roleAllows(role, tool));
  return {
    effect: allowed ? "allow" : "deny",
    effective_roles: effectiveRoles,
    matched_rule: null,
    reason: allowed ? "builtin_role_grant" : "trust_default_deny",
  };
}

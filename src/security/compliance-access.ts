import type { Identity } from "../types";

/** Closed permission vocabulary. Unknown strings are always denied. */
export const COMPLIANCE_PERMISSIONS = [
  "compliance.dashboard.read",
  "compliance.controls.read",
  "compliance.controls.write",
  "compliance.evidence.read_metadata",
  "compliance.evidence.read_content",
  "compliance.evidence.submit",
  "compliance.evidence.review",
  "compliance.approvals.request",
  "compliance.approvals.decide",
  "compliance.exceptions.manage",
  "compliance.incidents.read",
  "compliance.audit.export",
] as const;

export type CompliancePermission = typeof COMPLIANCE_PERMISSIONS[number];

const ROLE_PERMISSIONS: Readonly<Record<string, readonly CompliancePermission[]>> = {
  auditor: [
    "compliance.dashboard.read",
    "compliance.controls.read",
    "compliance.evidence.read_metadata",
    "compliance.evidence.review",
    "compliance.audit.export",
  ],
  compliance_manager: [
    "compliance.dashboard.read",
    "compliance.controls.read",
    "compliance.controls.write",
    "compliance.evidence.read_metadata",
    "compliance.evidence.read_content",
    "compliance.approvals.request",
    "compliance.exceptions.manage",
  ],
  control_owner: [
    "compliance.controls.read",
    "compliance.controls.write",
    "compliance.evidence.read_metadata",
    "compliance.evidence.submit",
    "compliance.approvals.request",
  ],
  evidence_reviewer: [
    "compliance.evidence.read_metadata",
    "compliance.evidence.read_content",
    "compliance.evidence.review",
  ],
  designated_approver: ["compliance.approvals.decide"],
  risk_owner: ["compliance.exceptions.manage"],
  incident_commander: ["compliance.incidents.read"],
  legal_reviewer: ["compliance.incidents.read"],
};

export type ComplianceAccessDecision =
  | { allowed: true }
  | {
      allowed: false;
      status: 401 | 403;
      error:
        | "authentication_required"
        | "tenant_assignment_required"
        | "tenant_scope_denied"
        | "permission_denied"
        | "self_approval_denied"
        | "unknown_permission";
    };

const DENY = (error: Exclude<ComplianceAccessDecision, { allowed: true }>["error"]):
  ComplianceAccessDecision => ({
    allowed: false,
    status: error === "authentication_required" ? 401 : 403,
    error,
  });

export function isCompliancePermission(value: string): value is CompliancePermission {
  return (COMPLIANCE_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Enforces identity, explicit tenant assignment, exact object tenant scope,
 * closed permission vocabulary, and separation of duties for approvals.
 * Call this for every Compliance Control Room route and every referenced object.
 */
export function authorizeComplianceAccess(input: {
  identity: Identity;
  permission: string;
  resourceTenant: string;
  requesterActor?: string;
  approverActor?: string;
}): ComplianceAccessDecision {
  const { identity, permission, resourceTenant, requesterActor, approverActor } = input;

  if (identity.method === "public") return DENY("authentication_required");
  if (identity.tenant.startsWith("unassigned-")) return DENY("tenant_assignment_required");
  if (!resourceTenant || identity.tenant !== resourceTenant) return DENY("tenant_scope_denied");
  if (!isCompliancePermission(permission)) return DENY("unknown_permission");

  const allowed = identity.roles.some((role) =>
    (ROLE_PERMISSIONS[role] ?? []).includes(permission)
  );
  if (!allowed) return DENY("permission_denied");

  if (
    permission === "compliance.approvals.decide" &&
    requesterActor &&
    approverActor &&
    requesterActor === approverActor
  ) return DENY("self_approval_denied");

  return { allowed: true };
}

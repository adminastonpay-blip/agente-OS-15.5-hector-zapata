import test from "node:test";
import assert from "node:assert/strict";
import type { Identity } from "../src/types";
import { authorizeComplianceAccess } from "../src/security/compliance-access.ts";

const identity = (roles: string[], tenant = "tenant-a", method: Identity["method"] = "access"): Identity => ({
  actor: "operator-a",
  method,
  tenant,
  roles,
  clearance: "confidential",
});

const decide = (who: Identity, permission: string, resourceTenant = "tenant-a", extra = {}) =>
  authorizeComplianceAccess({ identity: who, permission, resourceTenant, ...extra });

test("denies anonymous and unassigned machine identities", () => {
  assert.equal(decide(identity(["compliance_manager"], "public", "public"), "compliance.dashboard.read").allowed, false);
  assert.deepEqual(
    decide(identity(["admin"], "unassigned-machine-a", "apikey"), "compliance.dashboard.read"),
    { allowed: false, status: 403, error: "tenant_assignment_required" },
  );
});

test("denies cross-tenant object access even when role has permission", () => {
  assert.deepEqual(
    decide(identity(["auditor"]), "compliance.controls.read", "tenant-b"),
    { allowed: false, status: 403, error: "tenant_scope_denied" },
  );
});

test("denies unknown permissions and unknown roles", () => {
  assert.deepEqual(
    decide(identity(["compliance_manager"]), "compliance.root"),
    { allowed: false, status: 403, error: "unknown_permission" },
  );
  assert.deepEqual(
    decide(identity(["admin"]), "compliance.controls.write"),
    { allowed: false, status: 403, error: "permission_denied" },
  );
});

test("grants only the permission assigned to the closed role", () => {
  assert.deepEqual(decide(identity(["auditor"]), "compliance.evidence.review"), { allowed: true });
  assert.deepEqual(
    decide(identity(["auditor"]), "compliance.evidence.read_content"),
    { allowed: false, status: 403, error: "permission_denied" },
  );
});

test("prevents self-approval", () => {
  assert.deepEqual(
    decide(identity(["designated_approver"]), "compliance.approvals.decide", "tenant-a", {
      requesterActor: "operator-a",
      approverActor: "operator-a",
    }),
    { allowed: false, status: 403, error: "self_approval_denied" },
  );
});

test("allows a distinct designated approver within the same tenant", () => {
  assert.deepEqual(
    decide(identity(["designated_approver"]), "compliance.approvals.decide", "tenant-a", {
      requesterActor: "requester-b",
      approverActor: "operator-a",
    }),
    { allowed: true },
  );
});

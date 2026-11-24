/**
 * ASTON Control Assurance primitives for Cloudflare Workers + SQLite Durable Objects.
 *
 * Approval consumption uses a conditional SQLite UPDATE as the linearization point.
 * No signing or external side effect occurs until the row is claimed as "processing".
 */
import {
  importEd25519PrivateKey,
  importEd25519PublicKey,
  signAttestation,
  verifyAttestation,
} from "./attestation";

export type ApprovalDecision = "approved" | "rejected";
export type ApprovalStatus = "pending" | "processing" | "approved" | "rejected" | "expired";

export interface PendingApproval {
  id: string;
  action_json: string;
  identity_json: string;
  policy_json: string;
  created_at: number;
  expires_at: number;
  status: ApprovalStatus;
  decided_by?: string | null;
  decided_at?: number | null;
}

export interface ControlAssuranceEnv {
  TRUST?: DurableObjectNamespace;
  ATTESTATION_PRIVATE_KEY?: string;
  ATTESTATION_PUBLIC_KEY?: string;
  ATTESTATION_KEY_ID?: string;
}

export class ControlAssuranceError extends Error {
  constructor(
    public readonly statusCode: 403 | 409 | 410 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlAssuranceError";
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("invalid_base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Verify that TRUST exists and the configured PKCS#8/private + raw/public Ed25519 keys match. */
export async function assertCryptographicReadiness(env: ControlAssuranceEnv): Promise<void> {
  if (!env.TRUST) {
    throw new ControlAssuranceError(503, "TRUST_BINDING_MISSING", "TRUST Durable Object binding is unavailable.");
  }
  if (!env.ATTESTATION_PRIVATE_KEY || !env.ATTESTATION_PUBLIC_KEY || !env.ATTESTATION_KEY_ID) {
    throw new ControlAssuranceError(503, "ATTESTATION_KEYS_MISSING", "Ed25519 key configuration is incomplete.");
  }
  try {
    const privateKey = await importEd25519PrivateKey(decodeBase64Url(env.ATTESTATION_PRIVATE_KEY));
    const publicKey = await importEd25519PublicKey(decodeBase64Url(env.ATTESTATION_PUBLIC_KEY));
    const probe = await signAttestation(
      { schema: "aston.control-assurance.key-probe.v1", nonce: crypto.randomUUID() },
      privateKey,
      env.ATTESTATION_KEY_ID,
      "probe_" + crypto.randomUUID(),
    );
    if (!(await verifyAttestation(probe, publicKey))) throw new Error("keypair_mismatch");
  } catch {
    throw new ControlAssuranceError(503, "ATTESTATION_KEYPAIR_INVALID", "Ed25519 keypair failed cryptographic verification.");
  }
}

export interface ConsumeApprovalParams {
  approvalId: string;
  tenantId: string;
  operatorId: string;
  decision: ApprovalDecision;
  nowMs: number;
  /** Must return only after the decision attestation is created and self-verified. */
  signDecision: (record: PendingApproval) => Promise<string>;
  /** Must append to the existing tamper-evident audit chain. */
  appendAudit: (event: {
    tenant: string;
    actor: string;
    eventType: string;
    payload: Record<string, unknown>;
  }) => Promise<void>;
}

/**
 * Exactly-once approval resolution.
 *
 * The conditional UPDATE from pending -> processing is the atomic claim.
 * Durable Object requests may interleave while signing awaits crypto.subtle;
 * a second request therefore cannot claim the same approval.
 * If signing fails, the claim is released back to pending. A process crash
 * leaves "processing" (fail-closed); it is never silently treated as pending.
 */
export async function consumeApprovalAtomic(
  sql: SqlStorage,
  params: ConsumeApprovalParams,
): Promise<{ record: PendingApproval; attestationId: string }> {
  const rows = sql.exec<PendingApproval>(
    "SELECT * FROM pending_approvals WHERE id = ? LIMIT 1",
    params.approvalId,
  ).toArray();
  const record = rows[0];

  if (!record) {
    throw new ControlAssuranceError(403, "APPROVAL_NOT_FOUND", "Approval does not exist.");
  }
  if (record.identity_json) {
    let ownerTenant = "";
    try { ownerTenant = String((JSON.parse(record.identity_json) as { tenant?: unknown }).tenant ?? ""); } catch {}
    if (!ownerTenant || ownerTenant !== params.tenantId) {
      await params.appendAudit({
        tenant: ownerTenant || params.tenantId,
        actor: params.operatorId,
        eventType: "approval.cross_tenant_blocked",
        payload: { approval_id: params.approvalId, request_tenant: params.tenantId },
      });
      throw new ControlAssuranceError(403, "CROSS_TENANT_ACCESS_DENIED", "Tenant boundary violation.");
    }
  }

  if (record.status !== "pending") {
    await params.appendAudit({
      tenant: params.tenantId,
      actor: params.operatorId,
      eventType: "approval.replay_rejected",
      payload: { approval_id: params.approvalId, observed_status: record.status },
    });
    throw new ControlAssuranceError(409, "APPROVAL_ALREADY_CONSUMED", "Approval is not pending.");
  }

  if (params.nowMs >= Number(record.expires_at)) {
    const expired = sql.exec(
      "UPDATE pending_approvals SET status = 'expired' WHERE id = ? AND status = 'pending'",
      params.approvalId,
    );
    if (expired.rowsWritten === 1) {
      await params.appendAudit({
        tenant: params.tenantId,
        actor: params.operatorId,
        eventType: "approval.expired_rejected",
        payload: { approval_id: params.approvalId, expires_at: record.expires_at },
      });
    }
    throw new ControlAssuranceError(410, "APPROVAL_EXPIRED", "Approval has expired.");
  }

  const claim = sql.exec(
    "UPDATE pending_approvals SET status = 'processing' WHERE id = ? AND status = 'pending' AND expires_at > ?",
    params.approvalId,
    params.nowMs,
  );
  if (claim.rowsWritten !== 1) {
    await params.appendAudit({
      tenant: params.tenantId,
      actor: params.operatorId,
      eventType: "approval.replay_rejected",
      payload: { approval_id: params.approvalId, reason: "atomic_claim_conflict" },
    });
    throw new ControlAssuranceError(409, "APPROVAL_RACE_CONFLICT", "Approval was claimed by another request.");
  }

  try {
    const attestationId = await params.signDecision(record);
    if (!attestationId || attestationId.length > 256) throw new Error("invalid_attestation_id");

    const finalized = sql.exec(
      "UPDATE pending_approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'processing'",
      params.decision,
      params.operatorId,
      params.nowMs,
      params.approvalId,
    );
    if (finalized.rowsWritten !== 1) {
      throw new ControlAssuranceError(409, "APPROVAL_FINALIZE_CONFLICT", "Could not finalize claimed approval.");
    }

    await params.appendAudit({
      tenant: params.tenantId,
      actor: params.operatorId,
      eventType: "approval.consumed",
      payload: { approval_id: params.approvalId, decision: params.decision, attestation_id: attestationId },
    });
    return {
      record: { ...record, status: params.decision, decided_by: params.operatorId, decided_at: params.nowMs },
      attestationId,
    };
  } catch (error) {
    // Re-open only when this request still owns the processing state.
    sql.exec(
      "UPDATE pending_approvals SET status = 'pending' WHERE id = ? AND status = 'processing'",
      params.approvalId,
    );
    // If finalization succeeded but audit persistence failed, revoke the resolution
    // before returning 503. A signed receipt alone never authorizes execution.
    sql.exec(
      "UPDATE pending_approvals SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = ? AND status = ? AND decided_by = ? AND decided_at = ?",
      params.approvalId,
      params.decision,
      params.operatorId,
      params.nowMs,
    );
    throw error instanceof ControlAssuranceError
      ? error
      : new ControlAssuranceError(503, "APPROVAL_ATTESTATION_FAILED", "Decision signing failed; approval was not consumed.");
  }
}

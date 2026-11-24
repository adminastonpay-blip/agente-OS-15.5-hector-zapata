/**
 * ASTON Control Assurance — lease-based approval finalization.
 * Cryptography and hashing are prepared outside synchronous SQLite transactions.
 */
import { importEd25519PrivateKey, importEd25519PublicKey, signAttestation, verifyAttestation, type AttestationEnvelope } from "./attestation";
import { hashAuditRecord } from "../security/audit-chain";

export type ApprovalDecision = "approved" | "rejected";
export type ApprovalStatus = "pending" | "processing" | "approved" | "rejected" | "expired" | "EXPIRED_LEGACY_UNBOUND";

export interface PendingApproval {
  id: string; tenant_id: string; action_json: string; identity_json: string; policy_json: string;
  created_at: number; expires_at: number; status: ApprovalStatus;
  decided_by?: string | null; decided_at?: number | null;
  lease_id?: string | null; lease_expires_at?: number | null;
  processing_attempt: number; fencing_token: number;
  agent_id?: string | null; credential_id?: string | null;
}
interface ApprovalDbRow extends Record<string, SqlStorageValue> {
  id: string; tenant_id: string; action_json: string; identity_json: string; policy_json: string;
  created_at: number; expires_at: number; status: string; decided_by: string | null;
  decided_at: number | null; lease_id: string | null; lease_expires_at: number | null;
  processing_attempt: number; fencing_token: number;
  agent_id: string | null; credential_id: string | null;
}
interface AuditDbRow extends Record<string, SqlStorageValue> { event_hash: string; }

export interface ControlAssuranceEnv {
  TRUST?: DurableObjectNamespace; ATTESTATION_PRIVATE_KEY?: string;
  ATTESTATION_PUBLIC_KEY?: string; ATTESTATION_KEY_ID?: string;
}
export interface TransactionSyncStorage { transactionSync<T>(closure: () => T): T; }

export class ControlAssuranceError extends Error {
  constructor(public readonly statusCode: 400 | 403 | 404 | 409 | 410 | 503, public readonly code: string, message: string) {
    super(message); this.name = "ControlAssuranceError";
  }
}
function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("invalid_base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function hasSqlTable(sql: SqlStorage, tableName: string): boolean {
  const row = sql.exec<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name = ?",
    tableName
  ).toArray()[0];
  return Number(row?.cnt ?? 0) > 0;
}
function assertActivePrincipalStateSync(sql: SqlStorage, approval: PendingApproval, nowMs: number): void {
  if (hasSqlTable(sql, "tenants")) {
    const tenantRow = sql.exec<{ status: string }>(
      "SELECT status FROM tenants WHERE tenant_id = ? LIMIT 1",
      approval.tenant_id
    ).toArray()[0];
    if (tenantRow && String(tenantRow.status).toLowerCase() !== "active") {
      throw new ControlAssuranceError(403, "TENANT_INACTIVE_OR_REVOKED", "Tenant is not active.");
    }
  }
  const agentId = approval.agent_id ?? null;
  const credentialId = approval.credential_id ?? null;
  if (agentId && hasSqlTable(sql, "agents")) {
    const agentRow = sql.exec<{ status: string }>(
      "SELECT status FROM agents WHERE tenant_id = ? AND agent_id = ? LIMIT 1",
      approval.tenant_id, agentId
    ).toArray()[0];
    if (agentRow && String(agentRow.status).toLowerCase() !== "active") {
      throw new ControlAssuranceError(403, "AGENT_REVOKED_OR_QUARANTINED", "Agent is revoked or quarantined.");
    }
  }
  if (credentialId && hasSqlTable(sql, "agent_credentials")) {
    const credRow = sql.exec<{ status: string; expires_at: number | null; tenant_id: string; agent_id: string | null }>(
      "SELECT status, expires_at, tenant_id, agent_id FROM agent_credentials WHERE credential_id = ? LIMIT 1",
      credentialId
    ).toArray()[0];
    if (!credRow) {
      throw new ControlAssuranceError(403, "CREDENTIAL_NOT_FOUND", "Agent credential does not exist.");
    }
    if (credRow.tenant_id !== approval.tenant_id || (agentId && credRow.agent_id && credRow.agent_id !== agentId)) {
      throw new ControlAssuranceError(403, "CREDENTIAL_BINDING_MISMATCH", "Credential binding mismatch.");
    }
    if (String(credRow.status).toLowerCase() !== "active") {
      throw new ControlAssuranceError(403, "CREDENTIAL_REVOKED", "Agent credential is not active.");
    }
    if (credRow.expires_at !== null && credRow.expires_at !== undefined && Number(credRow.expires_at) <= nowMs) {
      throw new ControlAssuranceError(403, "CREDENTIAL_EXPIRED", "Agent credential has expired.");
    }
  }
}
export function consumeNonceSync(
  sql: SqlStorage,
  table: "admin_command_nonces" | "internal_assertion_nonces",
  key: string,
  scopeOrAud: string,
  expiresAt: number,
  nowMs: number
): void {
  if (!key || !scopeOrAud || !Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    throw new ControlAssuranceError(403, "NONCE_INVALID_OR_EXPIRED", "Nonce is missing, invalid, or expired.");
  }
  if (!hasSqlTable(sql, table)) {
    throw new ControlAssuranceError(503, "NONCE_STORE_MISSING", "Atomic nonce store is unavailable.");
  }
  if (table === "admin_command_nonces") {
    sql.exec("DELETE FROM admin_command_nonces WHERE expires_at <= ?", nowMs);
    const res = sql.exec(
      "INSERT OR IGNORE INTO admin_command_nonces (nonce_key, scope, expires_at, consumed_at) VALUES (?, ?, ?, ?)",
      key, scopeOrAud, expiresAt, nowMs
    );
    if (Number(res.rowsWritten ?? 0) !== 1) {
      throw new ControlAssuranceError(409, "ADMIN_COMMAND_REPLAY", "Admin command nonce already consumed.");
    }
    return;
  }
  sql.exec("DELETE FROM internal_assertion_nonces WHERE expires_at <= ?", nowMs);
  const res = sql.exec(
    "INSERT OR IGNORE INTO internal_assertion_nonces (jti, aud, expires_at, consumed_at) VALUES (?, ?, ?, ?)",
    key, scopeOrAud, expiresAt, nowMs
  );
  if (Number(res.rowsWritten ?? 0) !== 1) {
    throw new ControlAssuranceError(409, "ASSERTION_REPLAY", "Internal assertion nonce already consumed.");
  }
}
function mapApproval(row: ApprovalDbRow): PendingApproval {
  if (!row || typeof row.id !== "string" || typeof row.tenant_id !== "string" ||
      typeof row.identity_json !== "string" || typeof row.expires_at !== "number" ||
      !["pending", "processing", "approved", "rejected", "expired", "EXPIRED_LEGACY_UNBOUND"].includes(row.status)) {
    throw new ControlAssuranceError(503, "APPROVAL_ROW_INVALID", "Stored approval row is malformed.");
  }
  return {
    id: row.id, tenant_id: row.tenant_id, action_json: row.action_json,
    identity_json: row.identity_json, policy_json: row.policy_json,
    created_at: Number(row.created_at), expires_at: Number(row.expires_at),
    status: row.status as ApprovalStatus, decided_by: row.decided_by, decided_at: row.decided_at,
    lease_id: row.lease_id, lease_expires_at: row.lease_expires_at,
    processing_attempt: Number(row.processing_attempt ?? 0), fencing_token: Number(row.fencing_token ?? 0),
    agent_id: row.agent_id ?? null, credential_id: row.credential_id ?? null,
  };
}
function readApproval(sql: SqlStorage, id: string): PendingApproval | undefined {
  const rows = sql.exec<ApprovalDbRow>(
    "SELECT *, json_extract(identity_json, '$.tenant') AS tenant_id FROM pending_approvals WHERE id = ? LIMIT 1", id,
  ).toArray();
  return rows[0] ? mapApproval(rows[0]) : undefined;
}
function currentAuditHead(sql: SqlStorage, tenant: string): string {
  const row = sql.exec<AuditDbRow>(
    "SELECT event_hash FROM audit_events WHERE tenant = ? ORDER BY id DESC LIMIT 1", tenant,
  ).toArray()[0];
  return row?.event_hash ?? "GENESIS";
}
function auditRecord(event: {ts:number;tenant:string;actor:string;eventType:string;payload:Record<string,unknown>}): string {
  return JSON.stringify({ts:event.ts,tenant:event.tenant,actor:event.actor,event_type:event.eventType,payload:event.payload});
}
function insertAuditSync(sql: SqlStorage, event: {ts:number;tenant:string;actor:string;eventType:string;payload:Record<string,unknown>}, previous: string, hash: string): void {
  const result = sql.exec(
    "INSERT INTO audit_events (ts, tenant, actor, event_type, record_json, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
    event.ts,event.tenant,event.actor,event.eventType,auditRecord(event),previous,hash,
  );
  if (result.rowsWritten !== 1) throw new Error("audit_insert_not_confirmed");
}
function requireTenant(record: PendingApproval | undefined, tenant: string): PendingApproval {
  if (!record) throw new ControlAssuranceError(404,"APPROVAL_NOT_FOUND","Approval does not exist.");
  if (!tenant || record.tenant_id !== tenant) throw new ControlAssuranceError(403,"CROSS_TENANT_ACCESS_DENIED","Tenant boundary violation.");
  return record;
}

export async function assertCryptographicReadiness(env: ControlAssuranceEnv): Promise<void> {
  if (!env.TRUST) throw new ControlAssuranceError(503,"TRUST_BINDING_MISSING","TRUST Durable Object binding is unavailable.");
  if (!env.ATTESTATION_PRIVATE_KEY || !env.ATTESTATION_PUBLIC_KEY || !env.ATTESTATION_KEY_ID) {
    throw new ControlAssuranceError(503,"ATTESTATION_KEYS_MISSING","Ed25519 key configuration is incomplete.");
  }
  try {
    const priv=await importEd25519PrivateKey(decodeBase64Url(env.ATTESTATION_PRIVATE_KEY));
    const pub=await importEd25519PublicKey(decodeBase64Url(env.ATTESTATION_PUBLIC_KEY));
    const probe=await signAttestation({schema:"aston.control-assurance.key-probe.v1",nonce:crypto.randomUUID()},priv,env.ATTESTATION_KEY_ID,"probe_"+crypto.randomUUID());
    if (!(await verifyAttestation(probe,pub))) throw new Error("keypair_mismatch");
  } catch {
    throw new ControlAssuranceError(503,"ATTESTATION_KEYPAIR_INVALID","Ed25519 keypair failed cryptographic verification.");
  }
}

export interface LeaseClaimResult {
  approvalId:string; tenantId:string; leaseId:string; fencingToken:number;
  processingAttempt:number; leaseExpiresAt:number; expiresAt:number;
}
export interface ClaimOrRecoverLeaseParams {
  storage:TransactionSyncStorage; sql:SqlStorage; approvalId:string; tenantId:string;
  actorId:string; nowMs:number; leaseDurationMs?:number;
}

/** Initial claim or expired-lease recovery; CAS and audit append commit together. */
export async function claimOrRecoverLease(p: ClaimOrRecoverLeaseParams): Promise<LeaseClaimResult> {
  if (!Number.isFinite(p.nowMs)||!p.approvalId||!p.tenantId||!p.actorId||p.actorId.length>128)
    throw new ControlAssuranceError(400,"LEASE_CLAIM_INPUT_INVALID","Lease claim input is invalid.");
  const requested=p.leaseDurationMs??30000;
  if (!Number.isFinite(requested)) throw new ControlAssuranceError(400,"LEASE_DURATION_INVALID","Lease duration must be finite.");
  const duration=Math.min(60000,Math.max(5000,Math.trunc(requested)));
  const leaseId="lease_"+crypto.randomUUID();

  for(let attempt=0;attempt<8;attempt++){
    const old=requireTenant(readApproval(p.sql,p.approvalId),p.tenantId);
    if (old.status === "EXPIRED_LEGACY_UNBOUND") {
      throw new ControlAssuranceError(410, "APPROVAL_LEGACY_UNBOUND", "Legacy unbound approval is expired.");
    }
    const recoverable=old.status==="processing"&&old.lease_expires_at!==null&&old.lease_expires_at!==undefined&&p.nowMs>=old.lease_expires_at;
    if(old.status!=="pending"&&!recoverable){
      if(old.status==="expired"||p.nowMs>=old.expires_at) throw new ControlAssuranceError(410,"APPROVAL_EXPIRED","Approval has expired.");
      throw new ControlAssuranceError(409,"APPROVAL_LEASE_HELD_OR_CONSUMED","Approval is not claimable.");
    }
    if(p.nowMs>=old.expires_at) throw new ControlAssuranceError(410,"APPROVAL_EXPIRED","Approval has expired.");
    if(!Number.isSafeInteger(old.fencing_token)||old.fencing_token<0||old.fencing_token>=Number.MAX_SAFE_INTEGER||
       !Number.isSafeInteger(old.processing_attempt)||old.processing_attempt<0||old.processing_attempt>=Number.MAX_SAFE_INTEGER)
      throw new ControlAssuranceError(503,"LEASE_COUNTER_INVALID","Lease counters are invalid.");
    const leaseExpiresAt=Math.min(p.nowMs+duration,old.expires_at);
    if(leaseExpiresAt<=p.nowMs) throw new ControlAssuranceError(410,"APPROVAL_EXPIRED","Approval has no remaining lease window.");
    const token=old.fencing_token+1, count=old.processing_attempt+1;
    const event={ts:p.nowMs,tenant:p.tenantId,actor:p.actorId,eventType:recoverable?"approval.lease_recovered":"approval.lease_claimed",
      payload:{approval_id:old.id,lease_id:leaseId,fencing_token:token,processing_attempt:count,lease_expires_at:leaseExpiresAt}};
    const previous=currentAuditHead(p.sql,p.tenantId);
    const hash=await hashAuditRecord(previous,auditRecord(event));
    const outcome=p.storage.transactionSync(()=>{
      const fresh=readApproval(p.sql,p.approvalId);
      if(!fresh||fresh.tenant_id!==p.tenantId) throw new ControlAssuranceError(403,"CROSS_TENANT_ACCESS_DENIED","Tenant boundary violation.");
      if(fresh.status==="EXPIRED_LEGACY_UNBOUND") throw new ControlAssuranceError(410,"APPROVAL_LEGACY_UNBOUND","Legacy unbound approval is expired.");
      assertActivePrincipalStateSync(p.sql, fresh, p.nowMs);
      if(currentAuditHead(p.sql,p.tenantId)!==previous) return "retry" as const;
      if(fresh.expires_at<=p.nowMs) throw new ControlAssuranceError(410,"APPROVAL_EXPIRED","Approval has expired.");
      const eligible=fresh.status==="pending"||(fresh.status==="processing"&&fresh.lease_expires_at!==null&&fresh.lease_expires_at!==undefined&&fresh.lease_expires_at<=p.nowMs);
      if(!eligible||fresh.status!==old.status||fresh.lease_id!==old.lease_id||
         fresh.fencing_token!==old.fencing_token||fresh.processing_attempt!==old.processing_attempt)
        throw new ControlAssuranceError(409,"LEASE_CAS_CONFLICT","Another claimant changed the approval.");
      const updated=p.sql.exec(
        "UPDATE pending_approvals SET status='processing', lease_id=?, lease_expires_at=?, processing_attempt=?, fencing_token=? WHERE id=? AND status=? AND expires_at>? AND COALESCE(processing_attempt,0)=? AND COALESCE(fencing_token,0)=? AND ((?='pending') OR (status='processing' AND lease_expires_at<=?))",
        leaseId,leaseExpiresAt,count,token,p.approvalId,old.status,p.nowMs,old.processing_attempt,old.fencing_token,old.status,p.nowMs,
      );
      if(updated.rowsWritten!==1) throw new ControlAssuranceError(409,"LEASE_CAS_CONFLICT","Another claimant changed the approval.");
      insertAuditSync(p.sql,event,previous,hash);
      return "claimed" as const;
    });
    if(outcome==="retry") continue;
    return {approvalId:old.id,tenantId:old.tenant_id,leaseId,fencingToken:token,processingAttempt:count,leaseExpiresAt,expiresAt:old.expires_at};
  }
  throw new ControlAssuranceError(409,"AUDIT_CHAIN_CONTENTION","Could not append lease event after concurrent audit updates.");
}

export interface FinalizeApprovalWithLeaseParams {
  storage:TransactionSyncStorage; sql:SqlStorage; env:ControlAssuranceEnv;
  approvalId:string; tenantId:string;
  operator:{actor:string;tenant:string;roles:string[];method:string};
  decision:ApprovalDecision; nowMs:number; leaseId:string; fencingToken:number;
  attestation:AttestationEnvelope;
}

/** Atomically persists resolution + signed attestation + audit event for the exact live lease. */
export async function finalizeApprovalWithLease(p: FinalizeApprovalWithLeaseParams): Promise<{record:PendingApproval;attestationId:string}> {
  if(!p.operator||p.operator.method==="public"||p.operator.tenant!==p.tenantId||!p.operator.actor||
     p.operator.actor.length>128||!(p.operator.roles.includes("admin")||p.operator.roles.includes("approver")))
    throw new ControlAssuranceError(403,"VERIFIED_APPROVER_REQUIRED","A verified same-tenant approver is required.");
  if(!p.leaseId||!Number.isSafeInteger(p.fencingToken)||!Number.isFinite(p.nowMs)||
     (p.decision!=="approved"&&p.decision!=="rejected"))
    throw new ControlAssuranceError(400,"LEASE_FINALIZE_INPUT_INVALID","Lease finalization input is invalid.");
  const old=requireTenant(readApproval(p.sql,p.approvalId),p.tenantId);
  if(old.status!=="processing"||old.lease_id!==p.leaseId||old.fencing_token!==p.fencingToken||
     old.lease_expires_at===null||old.lease_expires_at===undefined||p.nowMs>=old.lease_expires_at||p.nowMs>=old.expires_at)
    throw new ControlAssuranceError(409,"LEASE_NOT_CURRENT_OR_EXPIRED","Lease is not current or has expired.");
  if(!p.env.ATTESTATION_PUBLIC_KEY||!p.env.ATTESTATION_KEY_ID)
    throw new ControlAssuranceError(503,"ATTESTATION_KEYS_MISSING","Attestation verification configuration is incomplete.");
  let verified=false;
  try{
    const pub=await importEd25519PublicKey(decodeBase64Url(p.env.ATTESTATION_PUBLIC_KEY));
    verified=p.attestation.key_id===p.env.ATTESTATION_KEY_ID&&await verifyAttestation(p.attestation,pub);
  }catch{verified=false;}
  const payload=p.attestation.payload as Record<string,unknown>;
  const label=p.decision==="approved"?"ALLOW":"DENY";
  if(!verified||payload.tenant!==p.tenantId||payload.actor!==p.operator.actor||
     payload.approval_id!==p.approvalId||payload.decision!==label||payload.phase!=="human_approval")
    throw new ControlAssuranceError(503,"ATTESTATION_INVALID","Decision attestation is invalid or does not match the approval.");

  const event={ts:p.nowMs,tenant:p.tenantId,actor:p.operator.actor,eventType:"approval.consumed",
    payload:{approval_id:p.approvalId,decision:p.decision,attestation_id:p.attestation.attestation_id,lease_id:p.leaseId,fencing_token:p.fencingToken}};
  const eventRecord=auditRecord(event);
  for(let attempt=0;attempt<8;attempt++){
    const previous=currentAuditHead(p.sql,p.tenantId);
    const hash=await hashAuditRecord(previous,eventRecord);
    const outcome=p.storage.transactionSync(()=>{
      const fresh=readApproval(p.sql,p.approvalId);
      if(!fresh||fresh.tenant_id!==p.tenantId) throw new ControlAssuranceError(403,"CROSS_TENANT_ACCESS_DENIED","Tenant boundary violation.");
      assertActivePrincipalStateSync(p.sql, fresh, p.nowMs);
      if(currentAuditHead(p.sql,p.tenantId)!==previous) return "retry" as const;
      if(fresh.status!=="processing"||fresh.lease_id!==p.leaseId||fresh.fencing_token!==p.fencingToken||
         fresh.lease_expires_at===null||fresh.lease_expires_at===undefined||
         p.nowMs>=fresh.lease_expires_at||p.nowMs>=fresh.expires_at)
        throw new ControlAssuranceError(409,"LEASE_NOT_CURRENT_OR_EXPIRED","Lease is not current or has expired.");
      const updated=p.sql.exec(
        "UPDATE pending_approvals SET status=?,decided_by=?,decided_at=?,lease_id=NULL,lease_expires_at=NULL WHERE id=? AND status='processing' AND lease_id=? AND fencing_token=? AND lease_expires_at>? AND expires_at>? AND json_extract(identity_json,'$.tenant')=?",
        p.decision,p.operator.actor,p.nowMs,p.approvalId,p.leaseId,p.fencingToken,p.nowMs,p.nowMs,p.tenantId,
      );
      if(updated.rowsWritten!==1) throw new ControlAssuranceError(409,"LEASE_FINALIZE_CAS_CONFLICT","Lease finalization CAS failed.");
      const att=p.sql.exec(
        "INSERT INTO decision_attestations (attestation_id,tenant,actor,decision,envelope_json,created_at) VALUES (?,?,?,?,?,?)",
        p.attestation.attestation_id,p.tenantId,p.operator.actor,label,JSON.stringify(p.attestation),p.nowMs,
      );
      if(att.rowsWritten!==1) throw new Error("attestation_insert_not_confirmed");
      insertAuditSync(p.sql,event,previous,hash);
      return "finalized" as const;
    });
    if(outcome==="retry") continue;
    return {record:{...old,status:p.decision,decided_by:p.operator.actor,decided_at:p.nowMs,lease_id:null,lease_expires_at:null},attestationId:p.attestation.attestation_id};
  }
  throw new ControlAssuranceError(409,"AUDIT_CHAIN_CONTENTION","Could not finalize after concurrent audit updates.");
}

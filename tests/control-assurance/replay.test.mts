import test from "node:test";
import assert from "node:assert/strict";
import {
  claimOrRecoverLease, finalizeApprovalWithLease, ControlAssuranceError,
  type PendingApproval, type TransactionSyncStorage,
} from "../../src/core/control-assurance.ts";
import { signAttestation, importEd25519PrivateKey } from "../../src/core/attestation.ts";

type Stored = PendingApproval & Record<string, any>;
function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,"").replace(/[+]/g,"-").replace(/[/]/g,"_");
}
async function keys() {
  const pair=await crypto.subtle.generateKey({name:"Ed25519"},true,["sign","verify"]) as CryptoKeyPair;
  return {
    privateKey:base64url(await crypto.subtle.exportKey("pkcs8",pair.privateKey)),
    publicKey:base64url(await crypto.subtle.exportKey("raw",pair.publicKey)),
  };
}
function harness(seed: Stored) {
  const approvals=new Map<string,Stored>([[seed.id,{...seed}]]);
  const audit:Array<Record<string,any>>=[];
  const attestations:Array<Record<string,any>>=[];
  let failNextAuditInsert=false;
  const sql={
    approvals,audit,attestations,
    exec<T>(query:string,...args:any[]) {
      const q=query.replace(/\\s+/g," ").trim();
      let rows:any[]=[]; let rowsWritten=0;
      if(q.startsWith("SELECT COUNT(*) AS cnt FROM sqlite_master")) {
        // This focused lease harness intentionally has no Gate A principal tables.
        rows=[{cnt:0}];
      } else if(q.startsWith("SELECT *, json_extract(identity_json")) {
        const row=approvals.get(String(args[0]));
        rows=row?[{...row,tenant_id:JSON.parse(row.identity_json).tenant}]:[];
      } else if(q.startsWith("SELECT event_hash FROM audit_events")) {
        const tenant=String(args[0]); const last=audit.filter(e=>e.tenant===tenant).at(-1);
        rows=last?[{event_hash:last.event_hash}]:[];
      } else if(q.startsWith("UPDATE pending_approvals SET status='processing'")) {
        const [leaseId,leaseExpiresAt,attempt,token,id,status,now,oldAttempt,oldToken,expectedStatus,recoverAt]=args;
        const row=approvals.get(String(id));
        const eligible=row&&(row.status==="pending"||(row.status==="processing"&&row.lease_expires_at!==null&&row.lease_expires_at<=Number(recoverAt)));
        if(row&&eligible&&row.status===status&&status===expectedStatus&&row.expires_at>Number(now)&&
           Number(row.processing_attempt)===Number(oldAttempt)&&Number(row.fencing_token)===Number(oldToken)){
          Object.assign(row,{status:"processing",lease_id:leaseId,lease_expires_at:leaseExpiresAt,processing_attempt:attempt,fencing_token:token}); rowsWritten=1;
        }
      } else if(q.startsWith("UPDATE pending_approvals SET status=?")) {
        const [status,actor,at,id,leaseId,token,leaseNow,approvalNow,tenant]=args;
        const row=approvals.get(String(id));
        if(row&&row.status==="processing"&&row.lease_id===leaseId&&row.fencing_token===token&&
           row.lease_expires_at>Number(leaseNow)&&row.expires_at>Number(approvalNow)&&
           JSON.parse(row.identity_json).tenant===tenant){
          Object.assign(row,{status,decided_by:actor,decided_at:at,lease_id:null,lease_expires_at:null}); rowsWritten=1;
        }
      } else if(q.startsWith("INSERT INTO decision_attestations")) {
        attestations.push({attestation_id:args[0],tenant:args[1],actor:args[2],decision:args[3],envelope_json:args[4],created_at:args[5]}); rowsWritten=1;
      } else if(q.startsWith("INSERT INTO audit_events")) {
        if(failNextAuditInsert){failNextAuditInsert=false;throw new Error("simulated_audit_storage_failure");}
        const [ts,tenant,actor,event_type,record_json,previous_hash,event_hash]=args;
        if(audit.some(e=>e.tenant===tenant&&e.previous_hash===previous_hash)) throw new Error("audit_unique_conflict");
        audit.push({ts,tenant,actor,event_type,record_json,previous_hash,event_hash}); rowsWritten=1;
      } else {
        throw new Error("Unsupported SQL: "+q);
      }
      return {rowsWritten,toArray:()=>rows as T[]};
    },
    failAudit(){failNextAuditInsert=true;},
  };
  const storage:TransactionSyncStorage={
    transactionSync<T>(closure:()=>T):T{
      const beforeApprovals=new Map([...approvals].map(([k,v])=>[k,{...v}]));
      const beforeAudit=audit.map(v=>({...v}));
      const beforeAttestations=attestations.map(v=>({...v}));
      try{return closure();}
      catch(error){
        approvals.clear(); for(const [k,v] of beforeApprovals) approvals.set(k,v);
        audit.splice(0,audit.length,...beforeAudit);
        attestations.splice(0,attestations.length,...beforeAttestations);
        throw error;
      }
    },
  };
  return {sql,storage,approvals,audit,attestations,failAudit:()=>sql.failAudit()};
}
const seed=():Stored=>({
  id:"apr-001",tenant_id:"tenant-alpha",action_json:JSON.stringify({tool:"transfer"}),
  identity_json:JSON.stringify({tenant:"tenant-alpha",actor:"agent-1"}),policy_json:"{}",
  created_at:1000,expires_at:50000,status:"pending",decided_by:null,decided_at:null,
  lease_id:null,lease_expires_at:null,processing_attempt:0,fencing_token:0,
});
const operator={actor:"human-1",tenant:"tenant-alpha",roles:["approver"],method:"access"};
async function makeSignedApproval(keysValue:Awaited<ReturnType<typeof keys>>, approvalId:string, decision:"approved"|"rejected") {
  const privateKey=await importEd25519PrivateKey(Uint8Array.from(atob(keysValue.privateKey.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-keysValue.privateKey.length%4)%4)),c=>c.charCodeAt(0)));
  return signAttestation({
    schema:"aston.safety.decision.v1",tenant:"tenant-alpha",actor:"human-1",phase:"human_approval",
    decision:decision==="approved"?"ALLOW":"DENY",action:{tool:"transfer"},policy:{decision:"require_approval"},
    approval_id:approvalId,
  },privateKey,"test-key","att_"+crypto.randomUUID(),"2026-11-24T12:00:00.000Z");
}
function params(h:ReturnType<typeof harness>, id="apr-001", now=2000) {
  return {storage:h.storage,sql:h.sql as unknown as SqlStorage,approvalId:id,tenantId:"tenant-alpha",actorId:"human-1",nowMs:now};
}
async function finalize(h:ReturnType<typeof harness>, lease:Awaited<ReturnType<typeof claimOrRecoverLease>>, now:number, keyPair:Awaited<ReturnType<typeof keys>>) {
  const attestation=await makeSignedApproval(keyPair,lease.approvalId,"approved");
  return finalizeApprovalWithLease({
    storage:h.storage,sql:h.sql as unknown as SqlStorage,
    env:{ATTESTATION_PUBLIC_KEY:keyPair.publicKey,ATTESTATION_KEY_ID:"test-key"},
    approvalId:lease.approvalId,tenantId:"tenant-alpha",operator,decision:"approved",nowMs:now,
    leaseId:lease.leaseId,fencingToken:lease.fencingToken,attestation,
  });
}

test("AST-LEASE-001: first claim grants exactly one live lease",async()=>{
  const h=harness(seed()); const first=await claimOrRecoverLease(params(h));
  assert.equal(h.approvals.get("apr-001")?.status,"processing");
  assert.equal(h.approvals.get("apr-001")?.lease_id,first.leaseId);
  assert.equal(first.fencingToken,1); assert.equal(first.processingAttempt,1);
  await assert.rejects(claimOrRecoverLease(params(h,"apr-001",3000)),
    e=>e instanceof ControlAssuranceError&&e.statusCode===409);
  assert.equal(h.audit.length,1);
});

test("AST-LEASE-002: expired processing lease recovers with a new lease and higher fencing token",async()=>{
  const h=harness(seed()); const first=await claimOrRecoverLease(params(h));
  const recovered=await claimOrRecoverLease(params(h,"apr-001",first.leaseExpiresAt));
  assert.notEqual(recovered.leaseId,first.leaseId);
  assert.ok(recovered.fencingToken>first.fencingToken);
  assert.equal(recovered.processingAttempt,first.processingAttempt+1);
  assert.equal(h.approvals.get("apr-001")?.lease_id,recovered.leaseId);
  assert.equal(h.audit.length,2);
});

test("AST-LEASE-003: two concurrent recoveries produce one CAS winner",async()=>{
  const h=harness(seed()); const first=await claimOrRecoverLease(params(h));
  const results=await Promise.allSettled([
    claimOrRecoverLease(params(h,"apr-001",first.leaseExpiresAt)),
    claimOrRecoverLease(params(h,"apr-001",first.leaseExpiresAt)),
  ]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(results.filter(r=>r.status==="rejected").length,1);
  assert.equal(h.approvals.get("apr-001")?.processing_attempt,2);
  assert.equal(h.audit.length,2);
});

test("AST-LEASE-004: an old lease cannot finalize after recovery",async()=>{
  const h=harness(seed()); const kp=await keys(); const first=await claimOrRecoverLease(params(h));
  const recovered=await claimOrRecoverLease(params(h,"apr-001",first.leaseExpiresAt));
  const before={...h.approvals.get("apr-001")!}; const auditCount=h.audit.length;
  const attestation=await makeSignedApproval(kp,"apr-001","approved");
  await assert.rejects(finalizeApprovalWithLease({
    storage:h.storage,sql:h.sql as unknown as SqlStorage,
    env:{ATTESTATION_PUBLIC_KEY:kp.publicKey,ATTESTATION_KEY_ID:"test-key"},
    approvalId:"apr-001",tenantId:"tenant-alpha",operator,decision:"approved",
    nowMs:first.leaseExpiresAt+1,leaseId:first.leaseId,fencingToken:first.fencingToken,attestation,
  }),e=>e instanceof ControlAssuranceError&&e.statusCode===409);
  assert.deepEqual(h.approvals.get("apr-001"),before);
  assert.equal(h.audit.length,auditCount);
  assert.notEqual(recovered.leaseId,first.leaseId);
});

test("AST-LEASE-005: finalization at or after lease expiry is rejected even with matching token",async()=>{
  const h=harness(seed()); const kp=await keys(); const lease=await claimOrRecoverLease(params(h));
  const attestation=await makeSignedApproval(kp,"apr-001","approved");
  await assert.rejects(finalizeApprovalWithLease({
    storage:h.storage,sql:h.sql as unknown as SqlStorage,
    env:{ATTESTATION_PUBLIC_KEY:kp.publicKey,ATTESTATION_KEY_ID:"test-key"},
    approvalId:"apr-001",tenantId:"tenant-alpha",operator,decision:"approved",
    nowMs:lease.leaseExpiresAt,leaseId:lease.leaseId,fencingToken:lease.fencingToken,attestation,
  }),e=>e instanceof ControlAssuranceError&&e.statusCode===409);
  assert.equal(h.approvals.get("apr-001")?.status,"processing");
  assert.equal(h.attestations.length,0);
});

test("AST-LEASE-006: audit failure rolls back resolution and attestation in the same transaction",async()=>{
  const h=harness(seed()); const kp=await keys(); const lease=await claimOrRecoverLease(params(h));
  const before={...h.approvals.get("apr-001")!}; const auditCount=h.audit.length;
  const attestation=await makeSignedApproval(kp,"apr-001","approved");
  h.failAudit();
  await assert.rejects(finalizeApprovalWithLease({
    storage:h.storage,sql:h.sql as unknown as SqlStorage,
    env:{ATTESTATION_PUBLIC_KEY:kp.publicKey,ATTESTATION_KEY_ID:"test-key"},
    approvalId:"apr-001",tenantId:"tenant-alpha",operator,decision:"approved",nowMs:3000,
    leaseId:lease.leaseId,fencingToken:lease.fencingToken,attestation,
  }));
  assert.deepEqual(h.approvals.get("apr-001"),before);
  assert.equal(h.attestations.length,0);
  assert.equal(h.audit.length,auditCount);
});

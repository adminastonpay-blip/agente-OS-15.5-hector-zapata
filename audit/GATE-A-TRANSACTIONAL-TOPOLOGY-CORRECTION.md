# Gate A — Transactional topology correction

**Status:** REQUIRED DESIGN CORRECTION before runtime implementation  
**Branch:** `feat/attestation-trust-fabric`  
**PR:** #82  
**No deployment, binding, secret, or Cloudflare configuration changes performed.**

## 1. Critical consistency constraint

Cloudflare Durable Object storage transactions are scoped to one Durable Object instance. `state.storage.transactionSync()` cannot atomically commit SQLite writes in two different Durable Objects.

In the current repository:
- `SafetyInterlock` owns `pending_approvals`, `decision_attestations`, and tenant audit rows in its SQLite storage.
- Trust Fabric is a separate Durable Object namespace/class and owns its own SQLite storage.
- A proposed global `ControlPlaneDO` would be a third independent storage boundary.

Therefore this sequence is NOT atomic and must not be represented as such:

1. Revoke tenant/agent in ControlPlaneDO.
2. Call SafetyInterlock to cancel pending approvals.
3. Return success.

A crash, timeout, retry, or concurrent finalization between steps 1 and 2 can leave a revoked principal with an apparently live approval. Two sequential transactions cannot provide the required AST-GATE-005 guarantee.

## 2. Safe topology for this repository

Use the existing per-tenant `SafetyInterlock` Durable Object as the tenant's authoritative lifecycle-and-approval transaction boundary for the first implementation. The Worker resolves the canonical tenant from a verified principal before selecting the DO ID. The DO pins its tenant identity on first authorized provisioning and rejects all cross-tenant requests.

Keep the following tables in the SAME SafetyInterlock SQLite database:
- `tenants` — one tenant row for this DO's tenant partition; status and monotonic `policy_epoch`.
- `agents` — agent IDs, tenant ownership, status, capability-profile hash, lifecycle version.
- `agent_credentials` — credential ID, agent/tenant ownership, Ed25519 public key or approved credential verifier, status, expiry and lifecycle version.
- Existing `pending_approvals`, `decision_attestations`, and `audit_events`.

This is a logical Control Plane Registry with tenant partitioning, not a new cross-DO global transaction. The table constraints and every query must include the pinned tenant ID. Global administrative inventory, if later needed, is a read model and never an authorization source.

## 3. Required operation serialization

Both lifecycle mutation and approval finalization must execute in the same SafetyInterlock DO and use the same SQLite `transactionSync()` boundary.

### Revocation / quarantine transaction

Within one synchronous transaction:
1. Revalidate the tenant partition and current row versions.
2. Apply the permitted state transition and increment lifecycle/policy epoch.
3. Invalidate all matching `pending` and `processing` approvals.
4. Clear `lease_id` and `lease_expires_at`; advance fencing token where applicable.
5. Record the hash-chained audit event.
6. Return success only after all writes succeed.

Scope:
- Credential revoke: approvals linked to that credential only.
- Agent quarantine/revoke: approvals linked to that agent.
- Tenant suspend/revoke: all approvals in that tenant partition.

The approval row must carry immutable `agent_id` and `credential_id` references. Deriving only tenant from `identity_json` is insufficient for scoped invalidation. Existing rows need a safe migration/backfill strategy; rows that cannot be attributed unambiguously must be invalidated or denied, never guessed.

### Lease finalization transaction

Within the same DO and synchronous transaction, re-read and require:
- tenant status exactly `ACTIVE`;
- agent status exactly `ACTIVE`;
- credential status exactly `ACTIVE`;
- matching tenant/agent/credential relationships;
- current lifecycle versions equal the versions captured by the lease/approval;
- unexpired credential, approval and lease (`nowMs < expires_at`);
- current lease ID and fencing token;
- audit-chain head unchanged.

Then update approval, insert attestation and append audit event atomically. Any failed condition aborts the transaction. Since revocation and finalization serialize on the same DO storage, exactly one order wins: if revocation commits first, finalization fails; if finalization commits first, it is a completed decision before revocation.

## 4. Cryptographic identity boundary

A caller-supplied `Identity` object is not a credential. The current `AgentNode /execute` route receives identity fields in JSON and cannot independently establish their authenticity.

Required design:
- The public Worker boundary verifies Cloudflare Access or a registered agent credential.
- It resolves the canonical principal and lifecycle records before forwarding.
- It creates a short-lived, audience-bound, signed internal principal assertion using a dedicated internal signing key (not the Ed25519 attestation key).
- The assertion binds actor, tenant ID, agent ID, credential ID, issuer, audience, issued-at, expiry, nonce, and lifecycle versions.
- AgentNode verifies the assertion signature, audience, expiry, nonce/replay protection, and any identity-like body fields. Mismatches are rejected and security-audited.
- AgentNode must not accept a body identity as an alternative when the assertion is absent.
- Internal signing and verification keys are separate from decision-attestation keys and are configured out-of-band. Missing keys => deny.

A public Access JWT is not automatically an agent credential. Agent credentials must be provisioned and bound to a tenant and agent in the registry. The signed assertion is an internal delegation created only after that verification.

## 5. Administrative authority

The root/operator verification key must be a dedicated Control Plane administrative public key configured out-of-band. It must not reuse:
- the attestation signing key;
- a model-provided key;
- a tenant admin role claim by itself;
- the API key or sensor shared secret.

Administrative mutation requests must be signed, bounded, replay-protected, and scoped to exact action, target, tenant, expiry, and nonce. A missing key or invalid signature denies all mutations. No self-service AgentNode route may provision or mutate lifecycle records.

No production key or secret is created by this change. The administrative key owner, custody, rotation, quorum/dual-control policy, and recovery ceremony must be approved before any real provisioning is enabled.

## 6. Migration and compatibility rules

- Migrations are additive and idempotent; preserve existing approvals, audit events and triggers.
- Do not invent agent/credential attribution for legacy approval rows.
- Legacy approvals lacking immutable agent/credential provenance are not eligible for finalization after enforcement is activated; fail closed and record the migration disposition.
- Keep SQLite row types separate from domain types and extend `Record<string, SqlStorageValue>`.
- Never await, hash, sign, fetch, or call another Durable Object inside `transactionSync()`.
- Prepare signatures and hashes before entering the transaction; revalidate the complete state inside it.
- Do not claim tenant-wide atomicity across multiple per-tenant Durable Objects. Each tenant's SafetyInterlock instance is the transaction authority for that tenant only.

## 7. Required test correction

AST-GATE-005 must use the real same-DO transaction path and deterministic interleaving:
- revocation commits first => finalize must fail with zero attestation/resolution side effects;
- finalize commits first => it is durably complete before revocation begins;
- no interleaving may produce a successful finalization after a committed revocation.

AST-GATE-003 and 004 must also assert that the same transaction invalidates all scoped pending/processing approvals, clears leases, fences stale workers, and appends the audit record. Test rollback by injecting a failure at each write.

## 8. Implementation blockers before activation

1. Dedicated internal assertion signing/verification key pair and custody approval.
2. Dedicated Control Plane admin verification public key and dual-control authority.
3. Approved credential enrollment/rotation process and mapping of existing principals.
4. Agent ID lifecycle: current Supervisor creates ephemeral `ag_*` IDs; these cannot be trusted as provisioned agents without an authenticated registration flow.
5. Explicit handling/migration of existing approvals without immutable agent and credential references.
6. Approval of the tenant-partitioned SafetyInterlock DO as the lifecycle authority, or a separately designed single-DO topology that colocates all approval state.

Until these are resolved, runtime enforcement must remain fail-closed and the registry must not be presented as operational.

## 9. Explicit safety boundary

This correction does not change runtime authentication or tool execution, does not add Wrangler bindings, does not configure secrets, and does not deploy. It prevents an invalid cross-DO atomicity claim and defines a topology that can actually satisfy the transaction requirement.

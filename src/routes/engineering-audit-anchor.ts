import type { Env, Identity } from "../types";
import { withOperationSpan } from "../observability/operation-span";
import type { TraceContext } from "../observability/request-span";

const TENANT_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const ROOT_HASH_PATTERN = /^[a-f0-9]{64}$/;

type AnchorCallResult = { httpStatus: number; payload: unknown };
type VerifiedAnchor = {
  rootHash: string;
  eventCount: number;
  blockHeight: number;
  timestamp?: number;
  localStateMissing: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function privileged(identity: Identity): boolean {
  return identity.method !== "public" &&
    (identity.roles.includes("admin") || identity.roles.includes("executor"));
}

function parseVerifiedAnchor(value: unknown, expectedEventCount: number): VerifiedAnchor | null {
  if (!isRecord(value) || value.ok !== true || value.integrity !== true ||
      value.event_count !== expectedEventCount ||
      typeof value.root_hash !== "string" || !ROOT_HASH_PATTERN.test(value.root_hash) ||
      !Number.isSafeInteger(value.bitcoin_block_height) ||
      (value.bitcoin_block_height as number) < 1 ||
      typeof value.local_state_missing !== "boolean") {
    return null;
  }
  if (value.bitcoin_timestamp !== undefined &&
      (!Number.isSafeInteger(value.bitcoin_timestamp) || (value.bitcoin_timestamp as number) < 0)) {
    return null;
  }
  return {
    rootHash: value.root_hash,
    eventCount: expectedEventCount,
    blockHeight: value.bitcoin_block_height as number,
    timestamp: value.bitcoin_timestamp as number | undefined,
    localStateMissing: value.local_state_missing,
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function digestEvidence(value: object): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/**
 * Privileged, read-only verification of an externally anchored tenant audit root.
 * Tenant scope is derived exclusively from the verified identity; the request
 * body cannot select a tenant. The verifier service remains the cryptographic
 * authority for OpenTimestamps/Bitcoin confirmation.
 */
export async function handleEngineeringAuditAnchorVerification(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (data: unknown, status?: number) => Response,
  traceContext: TraceContext,
): Promise<Response | null> {
  if (path !== "/v1/audit/anchor/verify") return null;
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!privileged(identity)) {
    return json({ ok: false, error: "engineering_privileged_role_required" }, 403);
  }
  if (typeof identity.tenant !== "string" || !TENANT_PATTERN.test(identity.tenant)) {
    return json({ ok: false, error: "audit_tenant_scope_invalid" }, 403);
  }

  const body = await req.json().catch(() => null) as unknown;
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "event_count") ||
      !Number.isSafeInteger(body.event_count) ||
      (body.event_count as number) < 1 || (body.event_count as number) > 1_000_000_000) {
    return json({ ok: false, error: "invalid_anchor_reference" }, 400);
  }
  const eventCount = body.event_count as number;

  const operation = await withOperationSpan(
    traceContext,
    env,
    "audit.external_anchor_verify",
    async (): Promise<AnchorCallResult> => {
      if (!env.SAFETY) return { httpStatus: 503, payload: null };
      try {
        const stub = env.SAFETY.get(env.SAFETY.idFromName(`audit:${identity.tenant}`));
        const response = await stub.fetch("https://safety.internal/audit/anchor/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenant: identity.tenant, event_count: eventCount }),
        });
        const payload = await response.json().catch(() => null) as unknown;
        return { httpStatus: response.status, payload };
      } catch {
        return { httpStatus: 503, payload: null };
      }
    },
    (result) => {
      if (result.httpStatus >= 500) return "unavailable";
      return result.httpStatus === 200 && parseVerifiedAnchor(result.payload, eventCount)
        ? "success"
        : "error";
    },
  );

  const checkedAt = new Date().toISOString();
  const verified = operation.value.httpStatus === 200
    ? parseVerifiedAnchor(operation.value.payload, eventCount)
    : null;

  let status: "confirmed" | "not_found" | "mismatch" | "unknown" = "unknown";
  let httpStatus = operation.value.httpStatus;
  let error: string | undefined;
  if (verified) {
    status = "confirmed";
    httpStatus = 200;
  } else if (operation.value.httpStatus === 404) {
    status = "not_found";
    error = "anchor_not_found";
  } else if (operation.value.httpStatus === 409) {
    status = "mismatch";
    error = "anchor_integrity_mismatch";
  } else if (operation.value.httpStatus === 400) {
    httpStatus = 400;
    error = "invalid_anchor_reference";
  } else if (operation.value.httpStatus === 503 || operation.value.httpStatus >= 500) {
    httpStatus = 503;
    error = "external_anchor_unavailable";
  } else {
    httpStatus = 503;
    error = "external_anchor_response_invalid";
  }

  const evidence = {
    schema: "aston.engineering.audit.external-verification.v1",
    status,
    event_count: eventCount,
    root_hash: verified?.rootHash ?? null,
    bitcoin_block_height: verified?.blockHeight ?? null,
    bitcoin_timestamp: verified?.timestamp ?? null,
    checked_at: checkedAt,
    trace_id: traceContext.traceId,
    request_operation_id: traceContext.spanId,
    operation_id: operation.spanId,
  };
  const evidenceDigest = await digestEvidence(evidence);

  return json({
    ok: status === "confirmed",
    service: "ASTON Engineering External Audit Assurance",
    mode: "external_anchor_verification",
    scope: "verified_identity_tenant",
    status,
    integrity: status === "confirmed" ? true : status === "mismatch" ? false : null,
    event_count: eventCount,
    ...(verified ? {
      root_hash: verified.rootHash,
      bitcoin_block_height: verified.blockHeight,
      ...(verified.timestamp !== undefined ? { bitcoin_timestamp: verified.timestamp } : {}),
      local_state_missing: verified.localStateMissing,
    } : {}),
    ...(error ? { error } : {}),
    observed_at: checkedAt,
    trace_id: traceContext.traceId,
    request_operation_id: traceContext.spanId,
    operation_id: operation.spanId,
    evidence: { ...evidence, digest: evidenceDigest },
    evidence_guarantee: "ephemeral_sha256_fingerprint_not_persisted_or_signed",
  }, httpStatus);
}

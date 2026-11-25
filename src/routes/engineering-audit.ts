import type { Env, Identity } from "../types";
import { withOperationSpan } from "../observability/operation-span";
import type { TraceContext } from "../observability/request-span";

const privileged = (identity: Identity) =>
  identity.method !== "public" &&
  (identity.roles.includes("admin") || identity.roles.includes("executor"));

const TENANT_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

type AuditChainResult =
  | { state: "verified"; intact: boolean; eventCount: number }
  | { state: "unavailable" }
  | { state: "invalid" };

type AuditStatus = "intact" | "empty" | "mismatch" | "unknown";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

async function digestEvidence(value: object): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return hex(new Uint8Array(digest));
}

/**
 * Read-only audit-chain verification for the authenticated tenant.
 * The tenant is never accepted from query/body input and is not returned raw.
 */
export async function handleEngineeringAuditVerification(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (data: unknown, status?: number) => Response,
  traceContext: TraceContext,
): Promise<Response | null> {
  if (path !== "/v1/engineering/audit/verify") return null;
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!privileged(identity)) {
    return json({ ok: false, error: "engineering_privileged_role_required" }, 403);
  }
  if (new URL(req.url).searchParams.has("tenant")) {
    return json({ ok: false, error: "tenant_override_not_supported" }, 400);
  }
  if (!TENANT_PATTERN.test(identity.tenant)) {
    return json({ ok: false, error: "audit_tenant_scope_invalid" }, 403);
  }

  const operation = await withOperationSpan(
    traceContext,
    env,
    "audit.chain_verify",
    async (): Promise<AuditChainResult> => {
      const safety = env.SAFETY;
      if (!safety) return { state: "unavailable" };

      try {
        const stub = safety.get(safety.idFromName(`audit:${identity.tenant}`));
        const response = await stub.fetch(
          `https://safety.internal/audit/verify?tenant=${encodeURIComponent(identity.tenant)}`,
          { method: "GET" },
        );
        if (!response.ok) return { state: "unavailable" };

        const payload = await response.json().catch(() => null) as unknown;
        if (!payload || typeof payload !== "object") return { state: "invalid" };
        const result = payload as Record<string, unknown>;
        if (
          result.tenant !== identity.tenant ||
          typeof result.intact !== "boolean" ||
          typeof result.events !== "number" ||
          !Number.isSafeInteger(result.events) ||
          result.events < 0 ||
          result.events > 1_000_000_000
        ) {
          return { state: "invalid" };
        }
        return { state: "verified", intact: result.intact, eventCount: result.events };
      } catch {
        return { state: "unavailable" };
      }
    },
    (result) => {
      if (result.state === "unavailable") return "unavailable";
      if (result.state === "invalid") return "error";
      return result.intact ? "success" : "error";
    },
  );

  const checkedAt = new Date().toISOString();
  const eventCount = operation.value.state === "verified"
    ? operation.value.eventCount
    : null;
  const status: AuditStatus = operation.value.state !== "verified"
    ? "unknown"
    : !operation.value.intact
      ? "mismatch"
      : operation.value.eventCount === 0 ? "empty" : "intact";
  const tenantHash = await sha256Hex(identity.tenant);
  const evidence = {
    schema: "aston.engineering.audit.verification.v1",
    tenant_hash: tenantHash,
    event_count: eventCount,
    integrity_status: status,
    checked_at: checkedAt,
    trace_id: traceContext.traceId,
    request_operation_id: traceContext.spanId,
    operation_id: operation.spanId,
  };
  const evidenceDigest = await digestEvidence(evidence);
  const httpStatus = status === "mismatch" ? 409 : status === "unknown" ? 503 : 200;

  return json({
    ok: status === "intact" || status === "empty",
    service: "ASTON Engineering Audit Assurance",
    mode: "audit_chain_verification",
    scope: "verified_identity_tenant",
    status,
    integrity: status === "unknown" ? null : status !== "mismatch",
    events: eventCount,
    tenant_hash: tenantHash,
    observed_at: checkedAt,
    trace_id: traceContext.traceId,
    request_operation_id: traceContext.spanId,
    operation_id: operation.spanId,
    evidence: { ...evidence, digest: evidenceDigest },
    evidence_guarantee: "ephemeral_sha256_fingerprint_not_persisted_or_signed",
  }, httpStatus);
}

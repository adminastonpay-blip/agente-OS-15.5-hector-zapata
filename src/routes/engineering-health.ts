import type { Env, Identity } from "../types";
import { withOperationSpan } from "../observability/operation-span";
import type { TraceContext } from "../observability/request-span";

const privileged = (identity: Identity) =>
  identity.method !== "public" &&
  (identity.roles.includes("admin") || identity.roles.includes("executor"));

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function digestEvidence(value: object): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

interface D1ProbeResult {
  status: "healthy" | "unhealthy" | "unknown";
  latencyMs: number;
}

/** Private, read-only runtime probe. It tests D1 itself, not just binding presence. */
export async function handleEngineeringHealth(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (data: unknown, status?: number) => Response,
  traceContext: TraceContext,
): Promise<Response | null> {
  if (path !== "/v1/engineering/health") return null;
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!privileged(identity)) return json({ ok: false, error: "engineering_privileged_role_required" }, 403);

  const operation = await withOperationSpan(
    traceContext,
    env,
    "d1.health_probe",
    async (): Promise<D1ProbeResult> => {
      if (!env.DB) return { status: "unknown", latencyMs: 0 };
      const started = performance.now();
      try {
        const row = await env.DB.prepare("SELECT 1 AS probe").first<{ probe: number }>();
        return {
          status: row?.probe === 1 ? "healthy" : "unhealthy",
          latencyMs: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
        };
      } catch {
        return {
          status: "unhealthy",
          latencyMs: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
        };
      }
    },
    (result) => result.status === "healthy"
      ? "success"
      : result.status === "unknown" ? "unavailable" : "error",
  );

  const checkedAt = new Date().toISOString();
  const evidence = {
    schema: "aston.engineering.health.evidence.v1",
    dependency: "d1",
    status: operation.value.status,
    checked_at: checkedAt,
    latency_ms: operation.value.latencyMs,
    trace_id: traceContext.traceId,
    request_operation_id: traceContext.spanId,
    operation_id: operation.spanId,
  };
  const evidenceDigest = await digestEvidence(evidence);
  const healthy = operation.value.status === "healthy";

  return json({
    ok: healthy,
    service: "ASTON Engineering Runtime Health",
    mode: "runtime_probe",
    scope: "d1_only",
    status: operation.value.status,
    observed_at: checkedAt,
    dependencies: {
      d1: { status: operation.value.status, latency_ms: operation.value.latencyMs },
    },
    trace_id: traceContext.traceId,
    request_operation_id: traceContext.spanId,
    operation_id: operation.spanId,
    evidence: { ...evidence, digest: evidenceDigest },
    evidence_guarantee: "ephemeral_sha256_fingerprint_not_persisted_or_signed",
  }, healthy ? 200 : 503);
}

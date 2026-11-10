/**
 * Sovereign architecture helpers (roadmap pillars).
 * Soft-fail when optional platform features are not bound yet.
 */
import type { Env, Identity } from "../types";
import { pqRuntimeProbe } from "../crypto/pq";

export type TenantPlan = "free" | "pro" | "sovereign" | "gov";

const PLAN_LIMITS: Record<
  TenantPlan,
  { cpu_ms: number; subrequests: number; max_body: number }
> = {
  free: { cpu_ms: 50, subrequests: 50, max_body: 64 * 1024 },
  pro: { cpu_ms: 300, subrequests: 500, max_body: 512 * 1024 },
  sovereign: { cpu_ms: 1000, subrequests: 2000, max_body: 2 * 1024 * 1024 },
  gov: { cpu_ms: 1000, subrequests: 2000, max_body: 2 * 1024 * 1024 },
};

/** Isolate tenant key for DO idFromName — prevents cross-tenant state bleed. */
export function tenantKey(identity: Identity, resource: string): string {
  const t = (identity.tenant || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `${t}::${resource}`;
}

export function planFromIdentity(identity: Identity, _untrustedHeaderPlan?: string | null): TenantPlan {
  // Plan upgrades must come from a verified identity-provider claim, never a client header.
  if (identity.plan) return identity.plan;
  if (identity.clearance === "secret" && identity.method !== "public") return "gov";
  if (
    identity.method !== "public" &&
    (identity.roles.includes("admin") || identity.roles.includes("executor"))
  ) return "sovereign";
  return "free";
}

export function enforceTenantBodyLimit(
  identity: Identity,
  contentLength: number,
  plan?: TenantPlan
): { ok: true } | { ok: false; error: string; limit: number } {
  const pl = plan || planFromIdentity(identity);
  const limit = PLAN_LIMITS[pl].max_body;
  if (contentLength > limit) {
    return { ok: false, error: `body exceeds plan limit (${pl})`, limit };
  }
  return { ok: true };
}

export async function sovereignStatus(env: Env) {
  const pq = await pqRuntimeProbe();
  return {
    architecture: "edge-monolith → sovereign-microservices path",
    version_target: "21.1-sovereign",
    pillars: {
      multi_tenant: {
        mode: "logical-isolate",
        note: "tenantKey() scopes DO names; Workers for Platforms dispatch namespaces are next step in dashboard",
        ready_for_wfp: true,
      },
      state: {
        hot: {
          durable_objects_sqlite: true,
          session: !!env.SESSION,
          graph: !!env.GRAPH,
        },
        cold: {
          hyperdrive: !!env.HYPERDRIVE,
          d1: !!env.DB,
          note: "Bind HYPERDRIVE to Postgres for bitemporal SSOT",
        },
      },
      sandbox: {
        safety_do: !!env.SAFETY,
        containers: false,
        note: "SafetyInterlock /sandbox/exec is fail-closed until Containers binding is enabled",
      },
      post_quantum: pq,
      resilience: {
        r2_journal: !!env.JOURNAL,
        etl_queue: !!env.ETL_QUEUE,
        ai_gateway: !!env.AI_GATEWAY_ID,
        workers_ai: !!env.AI,
      },
    },
    plan_limits: PLAN_LIMITS,
  };
}

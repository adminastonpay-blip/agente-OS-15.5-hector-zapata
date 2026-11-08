import type { Env, Identity } from "../types";
import { authenticate } from "../auth";

const PUBLIC_TENANT = "default";

/**
 * Resolve request identity.
 *
 * SECURITY (P0):
 * - Public callers NEVER set tenant via X-Aston-Tenant (tenant spoofing closed).
 * - Authenticated callers (Access / API key / sensor) may carry a tenant from auth or
 *   a validated header only when method !== public.
 */
export async function resolveIdentity(req: Request, env: Env): Promise<Identity> {
  try {
    const authed = await authenticate(req, env as any);
    if (authed) {
      // Allow tenant override only for non-public authenticated principals
      const hdr = (req.headers.get("X-Aston-Tenant") || "").trim().slice(0, 64);
      if (hdr && authed.method !== "public") {
        return { ...authed, tenant: sanitizeTenant(hdr) };
      }
      return { ...authed, tenant: sanitizeTenant(authed.tenant || PUBLIC_TENANT) };
    }
  } catch {
    /* auth module may reference optional Access vars */
  }

  // Public storefront identity — fixed tenant, ignore client-supplied tenant header
  return {
    actor: "public",
    method: "public",
    tenant: PUBLIC_TENANT,
    roles: ["viewer"],
    clearance: "public",
  };
}

function sanitizeTenant(t: string): string {
  const s = t.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
  return s || PUBLIC_TENANT;
}

export function requireAdmin(id: Identity, _env: Env): boolean {
  return (
    id.method !== "public" &&
    (id.roles.includes("admin") || id.roles.includes("executor"))
  );
}

/** True if identity can read/write another tenant's data */
export function canAccessTenant(id: Identity, resourceTenant: string): boolean {
  if (id.method === "public") return resourceTenant === PUBLIC_TENANT;
  if (id.roles.includes("admin")) return true;
  return id.tenant === resourceTenant;
}

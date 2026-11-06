import type { Env, Identity } from "../types";
import { authenticate } from "../auth";

/** Public identity for storefront; upgrade via Access JWT or API_KEY when present. */
export async function resolveIdentity(req: Request, env: Env): Promise<Identity> {
  try {
    const authed = await authenticate(req, env as any);
    if (authed) return authed as Identity;
  } catch {
    /* auth module may reference optional Access vars */
  }
  return {
    actor: "public",
    method: "public",
    tenant: req.headers.get("X-Aston-Tenant") || "default",
    roles: ["viewer"],
    clearance: "public",
  };
}

export function requireAdmin(id: Identity, _env: Env): boolean {
  // Fail closed: missing API_KEY must never turn an unauthenticated request into an admin.
  // Cloudflare Access identities may still administer when an explicit privileged role is present.
  return id.method !== "public" &&
    (id.roles.includes("admin") || id.roles.includes("executor"));
}

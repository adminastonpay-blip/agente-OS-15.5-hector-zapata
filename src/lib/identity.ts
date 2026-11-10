import type { Env, Identity } from "../types";
import { authenticate } from "../auth";

/** Public identity is isolated from caller-controlled tenant headers. */
export async function resolveIdentity(req: Request, env: Env): Promise<Identity> {
  try {
    const authed = await authenticate(req, env);
    if (authed) return authed;
  } catch {
    // Authentication failures are handled by the central API access boundary.
  }
  return {
    actor: "public",
    method: "public",
    tenant: "public",
    roles: ["viewer"],
    clearance: "public",
    plan: "free",
  };
}

export function requireAdmin(id: Identity, _env: Env): boolean {
  return id.method !== "public" &&
    (id.roles.includes("admin") || id.roles.includes("executor"));
}

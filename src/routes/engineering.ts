import type { Env, Identity } from "../types";
import { infraInventory } from "../infra/stack";
import { pillarStatus } from "./v21";

const privileged = (identity: Identity) =>
  identity.method !== "public" &&
  (identity.roles.includes("admin") || identity.roles.includes("executor"));

/**
 * Read-only Engineering NOC snapshot.
 * Reports configuration/binding evidence only; never claims remote runtime health.
 */
export async function handleEngineering(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (data: unknown, status?: number) => Response
): Promise<Response | null> {
  if (path !== "/v1/engineering/overview") return null;
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!privileged(identity)) return json({ ok: false, error: "engineering_privileged_role_required" }, 403);

  const inventory = infraInventory(env);
  const configured = inventory.filter((item) => item.bound).length;
  const notConfigured = inventory.length - configured;
  return json({
    ok: true,
    service: "ASTON Engineering Read-only API",
    version: "21.6.3-cf-audit",
    mode: "configuration_snapshot",
    warning: "Binding/configuration presence is not proof of runtime health, traffic, latency, or successful downstream operations.",
    observed_at: new Date().toISOString(),
    summary: { total_resources: inventory.length, configured, not_configured: notConfigured },
    pillars: pillarStatus(env),
    resources: inventory.map(({ id, cloudflare, role, bound, aston_route, phase }) => ({
      id, provider_resource: cloudflare, role, configured: bound,
      configuration_phase: phase, route: aston_route ?? null,
    })),
  });
}

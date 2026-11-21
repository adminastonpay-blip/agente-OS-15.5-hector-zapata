import type { Env, Identity } from "../types";
import { infraInventory } from "../infra/stack";
import { pillarStatus } from "./v21";

const privileged = (identity: Identity) =>
  identity.method !== "public" &&
  (identity.roles.includes("admin") || identity.roles.includes("executor"));

type BindingState = {
  id: string;
  status: "configured" | "unconfigured";
  evidence: string;
};

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
  if (path !== "/v1/engineering/overview" && path !== "/v1/engineering/health") return null;
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!privileged(identity)) return json({ ok: false, error: "engineering_privileged_role_required" }, 403);

  if (path === "/v1/engineering/health") {
    const checks: Array<{ id: string; status: "ok" | "unconfigured" | "error"; latency_ms?: number; evidence: string }> = [];
    if (!env.DB) {
      checks.push({ id: "d1", status: "unconfigured", evidence: "D1 binding is absent" });
    } else {
      const started = Date.now();
      try {
        const result = await env.DB.prepare("SELECT 1 AS health").first<{ health: number }>();
        checks.push({
          id: "d1",
          status: result?.health === 1 ? "ok" : "error",
          latency_ms: Date.now() - started,
          evidence: result?.health === 1 ? "SELECT 1 probe returned expected value" : "Probe returned unexpected result",
        });
      } catch {
        checks.push({ id: "d1", status: "error", latency_ms: Date.now() - started, evidence: "Probe failed; details intentionally omitted" });
      }
    }

    // These are binding-presence observations, not active service probes.
    // Keep each Durable Object class separate so a partial binding cannot look healthy.
    const bindings: Array<[string, unknown]> = [
      ["workers_ai", env.AI],
      ["do_session_memory", env.SESSION],
      ["do_graph_resolver", env.GRAPH],
      ["do_supervisor", env.SUPERVISOR],
      ["do_agent_node", env.AGENT],
      ["do_simulation_twin", env.SIMULATION],
      ["do_mission_brain", env.MISSION],
      ["do_safety_interlock", env.SAFETY],
      ["do_replay_guard", env.REPLAY_GUARD],
      ["queue_etl", env.ETL_QUEUE],
      ["queue_missions", env.MISSIONS],
      ["vectorize", env.VECTORIZE],
      ["r2_journal", env.JOURNAL],
      ["r2_audit_archive", env.AUDIT_ARCHIVE],
      ["hyperdrive", env.HYPERDRIVE],
      ["recovery_workflow", env.RECOVERY_WORKFLOW],
      ["ots_verifier", env.OTS_VERIFIER],
    ];
    const resources: BindingState[] = bindings.map(([id, binding]) => ({
      id,
      status: binding ? "configured" : "unconfigured",
      evidence: binding ? "Binding present; remote/runtime health not probed" : "Binding absent in this deployment environment",
    }));

    const d1 = checks[0].status;
    return json({
      ok: d1 === "ok",
      service: "ASTON Engineering Health Probe",
      mode: "read_only_probe",
      observed_at: new Date().toISOString(),
      checks,
      resource_summary: {
        total: resources.length,
        configured: resources.filter((item) => item.status === "configured").length,
        unconfigured: resources.filter((item) => item.status === "unconfigured").length,
      },
      resources,
      note: "D1 is actively probed with SELECT 1. All other resources report binding presence only, not live health.",
    }, d1 === "ok" ? 200 : 503);
  }

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

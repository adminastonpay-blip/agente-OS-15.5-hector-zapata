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
  if (path !== "/v1/engineering/overview" && path !== "/v1/engineering/health" && path !== "/v1/engineering/incidents") return null;
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!privileged(identity)) return json({ ok: false, error: "engineering_privileged_role_required" }, 403);

  // Incident feed is derived from the same authenticated, read-only health probe.
  // It is intentionally ephemeral: no D1 writes, incident history, or fake first_seen.
  if (path === "/v1/engineering/incidents") {
    const healthResponse = await handleEngineering("/v1/engineering/health", req, env, identity, json);
    if (!healthResponse) return null;
    const health = await healthResponse.json() as any;
    const observedAt = typeof health.observed_at === "string" ? health.observed_at : new Date().toISOString();
    const incidents: Array<{
      event_id: string;
      type: string;
      severity: "critical" | "high" | "medium" | "low";
      status: "open";
      resource: string;
      title: string;
      evidence: string;
      observed_at: string;
      source: "engineering_health_probe";
    }> = [];
    const add = (type: string, severity: "critical" | "high" | "medium" | "low", resource: string, title: string, evidence: string) => {
      incidents.push({
        event_id: `aston:${type}:${resource}`,
        type,
        severity,
        status: "open",
        resource,
        title,
        evidence,
        observed_at: observedAt,
        source: "engineering_health_probe",
      });
    };

    const d1 = Array.isArray(health.checks) ? health.checks.find((item: any) => item.id === "d1") : null;
    if (d1?.status === "error") {
      add("dependency_unavailable", "critical", "d1", "D1 connectivity probe failed", d1.evidence);
    } else if (d1?.status === "unconfigured") {
      add("dependency_unconfigured", "high", "d1", "D1 binding is not configured", d1.evidence);
    }

    if (d1?.status === "ok" && health.schema?.status === "empty") {
      add("schema_empty", "high", "d1_schema", "D1 has no user tables", health.schema.evidence);
    } else if (d1?.status === "ok" && health.schema?.status === "unavailable") {
      add("schema_inspection_unavailable", "medium", "d1_schema", "D1 schema inventory could not be inspected", health.schema.evidence);
    }
    if (d1?.status === "ok" && health.schema?.status === "ok" && health.schema?.migration_tracking_table === false) {
      add("migration_history_unverified", "low", "d1_schema", "Migration tracking table was not found", "This is an observation requiring reconciliation; it does not prove migrations were never applied.");
    }

    incidents.sort((a, b) => ["critical", "high", "medium", "low"].indexOf(a.severity) - ["critical", "high", "medium", "low"].indexOf(b.severity));
    return json({
      ok: true,
      service: "ASTON NOC Incident Feed",
      mode: "derived_read_only_snapshot",
      observed_at: observedAt,
      persistence: "not_persisted",
      history_available: false,
      write_operations: 0,
      summary: {
        total: incidents.length,
        critical: incidents.filter((item) => item.severity === "critical").length,
        high: incidents.filter((item) => item.severity === "high").length,
        medium: incidents.filter((item) => item.severity === "medium").length,
        low: incidents.filter((item) => item.severity === "low").length,
      },
      incidents,
      note: "Incidents are derived from current read-only probes. Optional binding absence is not classified as an incident. No historical first_seen or acknowledgement state is implied.",
    }, 200);
  }

  if (path === "/v1/engineering/health") {
    const checks: Array<{ id: string; status: "ok" | "unconfigured" | "error"; latency_ms?: number; evidence: string }> = [];
    let schema: { status: "ok" | "empty" | "unavailable" | "unconfigured"; user_table_count: number | null; migration_tracking_table: boolean | null; evidence: string } = {
      status: "unconfigured", user_table_count: null, migration_tracking_table: null,
      evidence: "D1 binding is absent; schema was not inspected",
    };
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

      if (checks[0].status === "ok") {
        try {
          const inventory = await env.DB.prepare(
            "SELECT COUNT(*) AS user_table_count, SUM(CASE WHEN name = 'd1_migrations' THEN 1 ELSE 0 END) AS migration_tracking_table FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV'"
          ).first<{ user_table_count: number; migration_tracking_table: number }>();
          const count = Number(inventory?.user_table_count);
          if (Number.isFinite(count)) {
            const hasMigrations = Number(inventory?.migration_tracking_table) > 0;
            schema = {
              status: count > 0 ? "ok" : "empty",
              user_table_count: count,
              migration_tracking_table: hasMigrations,
              evidence: hasMigrations
                ? "Read-only sqlite_master inventory completed; D1 migration tracking table is present"
                : "Read-only sqlite_master inventory completed; D1 migration tracking table was not found",
            };
          } else {
            schema = { status: "unavailable", user_table_count: null, migration_tracking_table: null, evidence: "Schema inventory returned no usable count" };
          }
        } catch {
          schema = { status: "unavailable", user_table_count: null, migration_tracking_table: null, evidence: "Schema inventory failed; details intentionally omitted" };
        }
      } else {
        schema = { status: "unavailable", user_table_count: null, migration_tracking_table: null, evidence: "Schema inventory skipped because the D1 connectivity probe failed" };
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
      schema,
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

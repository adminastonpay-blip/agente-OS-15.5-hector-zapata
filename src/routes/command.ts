import type { Env, Identity } from "../types";

type JsonFn = (d: unknown, s?: number) => Response;

const TENANT_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const TRACE_RE = /^[a-zA-Z0-9_-]{1,80}$/;

function environmentOf(req: Request, env: Env, identity: Identity): "staging" | "production" {
  const h = (req.headers.get("X-ASTON-Environment") || "").toLowerCase();
  if (h === "staging" || h === "production") return h;
  const profile = String(env.DEPLOY_PROFILE || "").toLowerCase();
  if (profile.includes("staging")) return "staging";
  if (identity.tenant === "lab-staging") return "staging";
  return "production";
}

function isGlobalOperator(identity: Identity): boolean {
  return (
    identity.method !== "public" &&
    (identity.roles.includes("admin") ||
      identity.roles.includes("executor") ||
      identity.roles.includes("command") ||
      identity.clearance === "secret")
  );
}

function resolveTenantScope(
  req: Request,
  identity: Identity
): { mode: "global" | "tenant"; tenant_id: string | null; error?: string } {
  const url = new URL(req.url);
  const q = (url.searchParams.get("tenant_id") || "").trim();
  if (q && !TENANT_RE.test(q)) {
    return { mode: "tenant", tenant_id: null, error: "invalid_tenant_id" };
  }
  if (isGlobalOperator(identity)) {
    if (q) return { mode: "tenant", tenant_id: q };
    return { mode: "global", tenant_id: null };
  }
  const pinned = identity.tenant && identity.tenant !== "public" ? identity.tenant : null;
  if (!pinned || !TENANT_RE.test(pinned)) {
    return { mode: "tenant", tenant_id: null, error: "tenant_required" };
  }
  if (q && q !== pinned) {
    return { mode: "tenant", tenant_id: null, error: "tenant_scope_forbidden" };
  }
  return { mode: "tenant", tenant_id: pinned };
}

function safetyStubKey(environment: string, tenantId: string): string {
  const t = tenantId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  const e = environment === "staging" ? "staging" : "production";
  return `${e}:${t}::safety`;
}

async function fetchSafetyLive(
  env: Env,
  environment: string,
  tenantId: string
): Promise<{
  interlock_state: "open" | "write_freeze" | "kill_switch_active";
  pending_count: number;
  pending: unknown[];
  log_tail: unknown[];
}> {
  const empty = {
    interlock_state: "open" as const,
    pending_count: 0,
    pending: [] as unknown[],
    log_tail: [] as unknown[],
  };
  if (!env.SAFETY || !tenantId) return empty;
  try {
    const stub = env.SAFETY.get(env.SAFETY.idFromName(safetyStubKey(environment, tenantId)));
    const [pendingRes, logRes, stateRes] = await Promise.all([
      stub.fetch("https://do/pending"),
      stub.fetch("https://do/log?limit=10"),
      stub.fetch("https://do/command-state").catch(() => null),
    ]);
    const pendingJson = pendingRes.ok ? await pendingRes.json<any>() : { pending: [] };
    const logJson = logRes.ok ? await logRes.json<any>() : { entries: [] };
    let interlock_state: "open" | "write_freeze" | "kill_switch_active" = "open";
    if (stateRes && stateRes.ok) {
      const st = await stateRes.json<any>();
      if (st?.interlock_state === "write_freeze" || st?.interlock_state === "kill_switch_active") {
        interlock_state = st.interlock_state;
      } else if (st?.kill_switch) interlock_state = "kill_switch_active";
      else if (st?.write_freeze) interlock_state = "write_freeze";
    }
    const pending = Array.isArray(pendingJson.pending) ? pendingJson.pending : [];
    return {
      interlock_state,
      pending_count: pending.length,
      pending,
      log_tail: Array.isArray(logJson.entries) ? logJson.entries : [],
    };
  } catch {
    return empty;
  }
}

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  try {
    const r = await db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`)
      .bind(name)
      .first<{ ok: number }>();
    return !!r?.ok;
  } catch {
    return false;
  }
}

async function overviewFromD1(
  db: D1Database,
  environment: string,
  tenantId: string | null
): Promise<{
  kpis: Record<string, number>;
  recent_events: unknown[];
  recent_decisions: unknown[];
  recent_executions: unknown[];
  tenants_summary: unknown[];
}> {
  const hasTelem = await tableExists(db, "telemetry_events");
  const hasDec = await tableExists(db, "decision_records");
  const hasExec = await tableExists(db, "execution_records");
  const hasTenants = await tableExists(db, "tenants");

  const kpis = {
    tenants_active: 0,
    tenants_down: 0,
    incidents_critical: 0,
    incidents_high: 0,
    incidents_in_containment: 0,
    identity_anomalies: 0,
    critical_vulns: 0,
    pending_approvals: 0,
  };

  let recent_events: unknown[] = [];
  let recent_decisions: unknown[] = [];
  let recent_executions: unknown[] = [];
  let tenants_summary: unknown[] = [];

  if (hasTenants) {
    const q = tenantId
      ? db
          .prepare(
            `SELECT tenant_id, display_name, status, interlock_state, autonomy_mode, environment
             FROM tenants WHERE environment = ? AND tenant_id = ? LIMIT 20`
          )
          .bind(environment, tenantId)
      : db
          .prepare(
            `SELECT tenant_id, display_name, status, interlock_state, autonomy_mode, environment
             FROM tenants WHERE environment = ? LIMIT 50`
          )
          .bind(environment);
    const rows = await q.all();
    tenants_summary = rows.results || [];
    for (const t of tenants_summary as any[]) {
      if (t.status === "active") kpis.tenants_active++;
      else kpis.tenants_down++;
    }
  }

  if (hasTelem) {
    const base = tenantId
      ? `FROM telemetry_events WHERE environment = ? AND tenant_id = ?`
      : `FROM telemetry_events WHERE environment = ?`;
    const binds = tenantId ? [environment, tenantId] : [environment];
    const crit = await db
      .prepare(`SELECT COUNT(*) AS c ${base} AND severity = 'critical' AND occurred_at > ?`)
      .bind(...binds, Date.now() - 24 * 3600 * 1000)
      .first<{ c: number }>();
    const high = await db
      .prepare(`SELECT COUNT(*) AS c ${base} AND severity = 'high' AND occurred_at > ?`)
      .bind(...binds, Date.now() - 24 * 3600 * 1000)
      .first<{ c: number }>();
    const idAnom = await db
      .prepare(
        `SELECT COUNT(*) AS c ${base} AND category IN ('auth','identity','ai_behavior') AND severity IN ('high','critical') AND occurred_at > ?`
      )
      .bind(...binds, Date.now() - 24 * 3600 * 1000)
      .first<{ c: number }>();
    const vulns = await db
      .prepare(
        `SELECT COUNT(*) AS c ${base} AND category = 'vulnerability' AND severity = 'critical' AND occurred_at > ?`
      )
      .bind(...binds, Date.now() - 7 * 24 * 3600 * 1000)
      .first<{ c: number }>();
    kpis.incidents_critical = Number(crit?.c || 0);
    kpis.incidents_high = Number(high?.c || 0);
    kpis.identity_anomalies = Number(idAnom?.c || 0);
    kpis.critical_vulns = Number(vulns?.c || 0);

    const ev = await db
      .prepare(
        `SELECT event_id, trace_id, tenant_id, category, severity, summary, source_type, source_id, occurred_at
         ${base} ORDER BY occurred_at DESC LIMIT 25`
      )
      .bind(...binds)
      .all();
    recent_events = ev.results || [];
  }

  if (hasDec) {
    const binds = tenantId ? [environment, tenantId] : [environment];
    const sql = tenantId
      ? `SELECT decision_id, trace_id, tenant_id, risk_score, threat_tag, verdict, rationale, decided_at
         FROM decision_records WHERE environment = ? AND tenant_id = ?
         ORDER BY decided_at DESC LIMIT 20`
      : `SELECT decision_id, trace_id, tenant_id, risk_score, threat_tag, verdict, rationale, decided_at
         FROM decision_records WHERE environment = ?
         ORDER BY decided_at DESC LIMIT 20`;
    const d = await db.prepare(sql).bind(...binds).all();
    recent_decisions = d.results || [];
  }

  if (hasExec) {
    const binds = tenantId ? [environment, tenantId] : [environment];
    const pending = await db
      .prepare(
        tenantId
          ? `SELECT COUNT(*) AS c FROM execution_records WHERE environment = ? AND tenant_id = ? AND status = 'pending_approval'`
          : `SELECT COUNT(*) AS c FROM execution_records WHERE environment = ? AND status = 'pending_approval'`
      )
      .bind(...binds)
      .first<{ c: number }>();
    kpis.pending_approvals = Number(pending?.c || 0);
    kpis.incidents_in_containment = kpis.pending_approvals;

    let ex: D1Result;
    try {
      ex = await db
        .prepare(
          tenantId
            ? `SELECT execution_id, decision_id, trace_id, tenant_id, action_type, target_type, target_id,
                      execution_mode, status, started_at, finished_at
               FROM execution_records WHERE environment = ? AND tenant_id = ?
               ORDER BY COALESCE(started_at, finished_at, 0) DESC LIMIT 20`
            : `SELECT execution_id, decision_id, trace_id, tenant_id, action_type, target_type, target_id,
                      execution_mode, status, started_at, finished_at
               FROM execution_records WHERE environment = ?
               ORDER BY COALESCE(started_at, finished_at, 0) DESC LIMIT 20`
        )
        .bind(...binds)
        .all();
    } catch {
      ex = { results: [], success: true, meta: {} as any };
    }
    recent_executions = ex.results || [];
  }

  return { kpis, recent_events, recent_decisions, recent_executions, tenants_summary };
}

function deriveThreatLevel(
  kpis: Record<string, number>,
  interlock: string
): "normal" | "elevated" | "containment" {
  if (interlock === "write_freeze" || interlock === "kill_switch_active") return "containment";
  if (kpis.incidents_critical > 0 || kpis.pending_approvals > 2) return "elevated";
  if (kpis.incidents_high > 3 || kpis.identity_anomalies > 5) return "elevated";
  return "normal";
}

export async function handleCommand(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: JsonFn
): Promise<Response | null> {
  if (!path.startsWith("/v1/command")) return null;

  if (identity.method === "public") {
    return json({ ok: false, error: "authentication_required" }, 401);
  }

  const environment = environmentOf(req, env, identity);
  const scope = resolveTenantScope(req, identity);
  if (scope.error) {
    const status = scope.error === "tenant_scope_forbidden" ? 403 : 400;
    return json({ ok: false, error: scope.error }, status);
  }

  if (path === "/v1/command/overview" && req.method === "GET") {
    if (!env.DB) {
      return json({
        ok: true,
        environment,
        scope: scope.mode,
        tenant_id: scope.tenant_id,
        d1_bound: false,
        safety_bound: !!env.SAFETY,
        threat_level: "normal",
        interlock_state: "open",
        kpis: {},
        message: "D1 not bound — apply sql/aston_command_schema.sql",
      });
    }

    const d1 = await overviewFromD1(env.DB, environment, scope.tenant_id);
    let interlock_state: "open" | "write_freeze" | "kill_switch_active" = "open";
    let live_pending: unknown[] = [];
    let live_pending_count = 0;

    if (scope.tenant_id) {
      const live = await fetchSafetyLive(env, environment, scope.tenant_id);
      interlock_state = live.interlock_state;
      live_pending = live.pending;
      live_pending_count = live.pending_count;
      d1.kpis.pending_approvals = Math.max(d1.kpis.pending_approvals, live_pending_count);
    } else if (d1.tenants_summary.length) {
      for (const t of (d1.tenants_summary as any[]).slice(0, 5)) {
        const live = await fetchSafetyLive(env, environment, t.tenant_id);
        if (live.interlock_state === "kill_switch_active") interlock_state = "kill_switch_active";
        else if (live.interlock_state === "write_freeze" && interlock_state === "open") {
          interlock_state = "write_freeze";
        }
        live_pending_count += live.pending_count;
        if (live.pending.length) live_pending.push(...live.pending.slice(0, 3));
      }
      d1.kpis.pending_approvals = Math.max(d1.kpis.pending_approvals, live_pending_count);
    }

    if (scope.tenant_id && d1.tenants_summary.length) {
      const row = (d1.tenants_summary as any[])[0];
      if (row?.interlock_state === "write_freeze" || row?.interlock_state === "kill_switch_active") {
        interlock_state = row.interlock_state;
      }
    }

    const threat_level = deriveThreatLevel(d1.kpis, interlock_state);

    return json({
      ok: true,
      environment,
      scope: scope.mode,
      tenant_id: scope.tenant_id,
      threat_level,
      interlock_state,
      kill_switch: interlock_state === "kill_switch_active",
      write_freeze: interlock_state === "write_freeze",
      kpis: d1.kpis,
      tenants: d1.tenants_summary,
      recent_events: d1.recent_events,
      recent_decisions: d1.recent_decisions,
      recent_executions: d1.recent_executions,
      live_pending_approvals: live_pending,
      bindings: { d1: true, safety: !!env.SAFETY },
      ts: Date.now(),
    });
  }

  if (path === "/v1/command/events" && req.method === "GET") {
    if (!env.DB) return json({ ok: false, error: "d1_not_bound" }, 503);
    if (!(await tableExists(env.DB, "telemetry_events"))) {
      return json({
        ok: true,
        environment,
        count: 0,
        events: [],
        note: "telemetry_events table missing — apply sql/aston_command_schema.sql",
      });
    }

    const url = new URL(req.url);
    const severity = (url.searchParams.get("severity") || "").toLowerCase();
    const category = (url.searchParams.get("category") || "").toLowerCase();
    const trace_id = (url.searchParams.get("trace_id") || "").trim();
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);

    if (trace_id && !TRACE_RE.test(trace_id)) {
      return json({ ok: false, error: "invalid_trace_id" }, 400);
    }

    const clauses: string[] = ["environment = ?"];
    const binds: (string | number)[] = [environment];
    if (scope.tenant_id) {
      clauses.push("tenant_id = ?");
      binds.push(scope.tenant_id);
    }
    if (severity && ["info", "low", "medium", "high", "critical"].includes(severity)) {
      clauses.push("severity = ?");
      binds.push(severity);
    }
    if (
      category &&
      ["auth", "identity", "ai_behavior", "network", "vulnerability", "config_drift", "health"].includes(category)
    ) {
      clauses.push("category = ?");
      binds.push(category);
    }
    if (trace_id) {
      clauses.push("trace_id = ?");
      binds.push(trace_id);
    }

    const where = clauses.join(" AND ");
    const countRow = await env.DB
      .prepare(`SELECT COUNT(*) AS c FROM telemetry_events WHERE ${where}`)
      .bind(...binds)
      .first<{ c: number }>();
    const rows = await env.DB
      .prepare(
        `SELECT event_id, trace_id, tenant_id, environment, occurred_at, ingested_at,
                source_type, source_id, category, severity, summary, evidence_r2_key
         FROM telemetry_events WHERE ${where}
         ORDER BY occurred_at DESC LIMIT ? OFFSET ?`
      )
      .bind(...binds, limit, offset)
      .all();

    return json({
      ok: true,
      environment,
      scope: scope.mode,
      tenant_id: scope.tenant_id,
      count: Number(countRow?.c || 0),
      limit,
      offset,
      events: rows.results || [],
    });
  }

  if (path === "/v1/command/executions" && req.method === "GET") {
    if (!env.DB) return json({ ok: false, error: "d1_not_bound" }, 503);

    const url = new URL(req.url);
    const status = (url.searchParams.get("status") || "").toLowerCase();
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);

    const allowedStatus = new Set([
      "queued",
      "pending_approval",
      "running",
      "succeeded",
      "failed",
      "blocked",
      "rolled_back",
    ]);

    let live_pending: unknown[] = [];
    if (scope.tenant_id && env.SAFETY && (!status || status === "pending_approval")) {
      const live = await fetchSafetyLive(env, environment, scope.tenant_id);
      live_pending = live.pending;
    }

    if (!(await tableExists(env.DB, "execution_records"))) {
      return json({
        ok: true,
        environment,
        scope: scope.mode,
        tenant_id: scope.tenant_id,
        count: live_pending.length,
        executions: [],
        live_pending_approvals: live_pending,
        note: "execution_records table missing — apply sql/aston_command_schema.sql",
      });
    }

    const clauses: string[] = ["environment = ?"];
    const binds: (string | number)[] = [environment];
    if (scope.tenant_id) {
      clauses.push("tenant_id = ?");
      binds.push(scope.tenant_id);
    }
    if (status && allowedStatus.has(status)) {
      clauses.push("status = ?");
      binds.push(status);
    }
    const where = clauses.join(" AND ");
    const countRow = await env.DB
      .prepare(`SELECT COUNT(*) AS c FROM execution_records WHERE ${where}`)
      .bind(...binds)
      .first<{ c: number }>();

    const rows = await env.DB
      .prepare(
        `SELECT execution_id, decision_id, trace_id, tenant_id, environment,
                action_type, target_type, target_id, parameters,
                execution_mode, status, approved_by, started_at, finished_at,
                before_state_hash, after_state_hash, audit_r2_key, error_message
         FROM execution_records WHERE ${where}
         ORDER BY COALESCE(started_at, finished_at, 0) DESC LIMIT ? OFFSET ?`
      )
      .bind(...binds, limit, offset)
      .all()
      .catch(async () =>
        env.DB!.prepare(
          `SELECT execution_id, decision_id, trace_id, tenant_id, environment,
                  action_type, target_type, target_id,
                  execution_mode, status, approved_by, started_at, finished_at
           FROM execution_records WHERE ${where}
           ORDER BY COALESCE(started_at, finished_at, 0) DESC LIMIT ? OFFSET ?`
        )
          .bind(...binds, limit, offset)
          .all()
      );

    return json({
      ok: true,
      environment,
      scope: scope.mode,
      tenant_id: scope.tenant_id,
      count: Number(countRow?.c || 0),
      limit,
      offset,
      executions: rows.results || [],
      live_pending_approvals: live_pending,
    });
  }

  if (path === "/v1/command/tenants" && req.method === "GET") {
    if (!env.DB) return json({ ok: false, error: "d1_not_bound" }, 503);
    if (!(await tableExists(env.DB, "tenants"))) {
      return json({ ok: true, tenants: [], note: "tenants table missing" });
    }
    if (!isGlobalOperator(identity) && scope.tenant_id) {
      const row = await env.DB
        .prepare(`SELECT * FROM tenants WHERE tenant_id = ? AND environment = ?`)
        .bind(scope.tenant_id, environment)
        .first();
      return json({ ok: true, environment, tenants: row ? [row] : [] });
    }
    if (!isGlobalOperator(identity)) {
      return json({ ok: false, error: "privileged_role_required" }, 403);
    }
    const rows = await env.DB
      .prepare(`SELECT * FROM tenants WHERE environment = ? ORDER BY display_name LIMIT 200`)
      .bind(environment)
      .all();
    return json({ ok: true, environment, tenants: rows.results || [] });
  }

  if (path === "/v1/command/health" && req.method === "GET") {
    return json({
      ok: true,
      environment,
      service: "ASTON Command",
      bindings: {
        d1: !!env.DB,
        safety: !!env.SAFETY,
        session: !!env.SESSION,
        journal: !!env.JOURNAL,
        audit_archive: !!env.AUDIT_ARCHIVE,
        etl_queue: !!env.ETL_QUEUE,
      },
      ts: Date.now(),
    });
  }

  return json({ ok: false, error: "command_route_not_found" }, 404);
}

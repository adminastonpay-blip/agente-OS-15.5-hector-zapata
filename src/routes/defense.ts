import type { Env, Identity } from "../types";
import {
  deterministicTriage,
  proposeMitigation,
  deepInvestigate,
  persistIncident,
  listIncidents,
  gateMitigation,
  normalizeEvidence,
  type Incident,
} from "../defense/autodefense";

export async function handleDefense(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
  // Full pipeline in one call
  if (path === "/v1/defense/ingest" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const evidence = normalizeEvidence(body);
    if (!evidence.length) return json({ ok: false, error: "evidence or message required" }, 400);

    const triage = deterministicTriage(evidence);
    const id = `inc_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();

    let incident: Incident = {
      id,
      tenant: identity.tenant || "default",
      title: String(body.title || evidence[0].value).slice(0, 120),
      severity: triage.severity,
      status: triage.auto_close ? "false_positive" : "triaged",
      evidence,
      triage,
      created_at: now,
      updated_at: now,
    };

    // Deep investigate only if not auto-closed benign
    if (!triage.auto_close && (triage.label === "suspicious" || triage.label === "malicious")) {
      incident.status = "investigating";
      try {
        incident.investigation = await deepInvestigate(env, incident);
      } catch (e: any) {
        incident.investigation = `investigate_error: ${String(e?.message || e).slice(0, 120)}`;
      }
    }

    const mitigation = proposeMitigation(triage, evidence);
    incident.mitigation = mitigation;

    let gate: any = { status: "skipped", message: "no mitigation needed" };
    if (!triage.auto_close) {
      incident.status = "mitigating";
      gate = await gateMitigation(env, identity, mitigation, incident);
      if (gate.status === "pending_approval") incident.status = "pending_approval";
      else if (gate.status === "allowed") incident.status = "closed";
      else if (gate.status === "denied") incident.status = "open";
    }

    incident.updated_at = Date.now();
    await persistIncident(env, incident);

    return json({
      ok: true,
      incident: {
        id: incident.id,
        severity: incident.severity,
        status: incident.status,
        triage: incident.triage,
        investigation: incident.investigation,
        mitigation: incident.mitigation,
      },
      gate,
      principles: {
        deterministic_first: true,
        human_in_the_loop_high_impact: true,
        no_magic_shield: true,
      },
    });
  }

  if (path === "/v1/defense/triage" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const evidence = normalizeEvidence(body);
    if (!evidence.length) return json({ ok: false, error: "evidence required" }, 400);
    return json({ ok: true, triage: deterministicTriage(evidence) });
  }

  if (path === "/v1/defense/investigate" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const evidence = normalizeEvidence(body);
    if (!evidence.length) return json({ ok: false, error: "evidence required" }, 400);
    const triage = deterministicTriage(evidence);
    const incident: Incident = {
      id: `tmp_${Date.now()}`,
      tenant: identity.tenant || "default",
      title: "adhoc",
      severity: triage.severity,
      status: "investigating",
      evidence,
      triage,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const investigation = await deepInvestigate(env, incident);
    return json({
      ok: true,
      triage,
      investigation,
      mitigation: proposeMitigation(triage, evidence),
    });
  }

  // Human decision passthrough to SafetyInterlock
  if (path === "/v1/defense/approve" && req.method === "POST") {
    if (!env.SAFETY) return json({ ok: false, error: "SAFETY DO not bound" }, 503);
    const body = await req.json<any>().catch(() => ({}));
    const approval_id = String(body.approval_id || "");
    if (!approval_id) return json({ ok: false, error: "approval_id required" }, 400);
    const approved = body.approved !== false;
    // The actor must come from the authenticated identity, never caller-controlled JSON.
    const operator = identity.actor;
    const stub = env.SAFETY.get(env.SAFETY.idFromName(tenantKeySafe(identity)));
    const res = await stub.fetch("https://do/decide", {
      method: "POST",
      body: JSON.stringify({ approval_id, approved, operator }),
    });
    const data = await res.json<any>();
    return json({ ok: !data.error, ...data }, data.status && data.error ? data.status : 200);
  }

  if (path === "/v1/defense/status" && req.method === "GET") {
    return json({
      ok: true,
      service: "ASTON OS Autodefense",
      pipeline: ["collect", "triage", "investigate", "mitigate", "human_approve"],
      safety_bound: !!env.SAFETY,
      supervisor_bound: !!env.SUPERVISOR,
      d1: !!env.DB,
      limits: {
        auto_block_critical: false,
        human_required_for: ["block_ip", "block_pattern"],
        auto_allowed: ["observe", "rate_limit_soft"],
      },
      note: "Assists operators — does not claim global network restart or perfect AI detection",
    });
  }

  return null;
}

function tenantKeySafe(identity: Identity): string {
  const t = (identity.tenant || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `${t}::safety`;
}

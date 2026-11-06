import type { Env, Identity } from "../types";
import { emitLineage } from "../lineage";
import { evaluateAccess } from "../access/access";

export type DecisionStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "executed"
  | "closed";

export async function createDecision(
  env: Env,
  id: Identity,
  input: {
    title: string;
    objective: string;
    alternatives?: unknown[];
    kpis?: string[];
    simulation_id?: string;
    owner?: string;
  }
) {
  if (!env.DB) throw new Error("DB binding required");
  if (!input?.title || !input?.objective) {
    throw new Error("title y objective son requeridos");
  }

  const access = await evaluateAccess(env, id, {
    action: "create",
    object_type: "decision",
    purpose: "decision",
  });

  if (access.effect === "deny") {
    throw new Error(`access_denied:${access.reason}`);
  }

  const decisionId = `dec_${crypto.randomUUID()}`;
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO decisions
       (id, tenant, title, objective, alternatives, kpis, simulation_id, status, owner, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`
  )
    .bind(
      decisionId,
      id.tenant,
      input.title,
      input.objective,
      JSON.stringify(input.alternatives ?? []),
      JSON.stringify(input.kpis ?? []),
      input.simulation_id ?? null,
      input.owner ?? id.actor,
      id.actor,
      now,
      now
    )
    .run();

  await emitLineage(env, {
    object_id: decisionId,
    transformation: "decision.created",
    pipeline_version: "v1",
    actor: id.actor,
    metadata: { title: input.title, simulation_id: input.simulation_id ?? null },
  });

  return { decision_id: decisionId, status: "draft", access_decision_id: access.decision_id };
}

async function getDecision(env: Env, tenant: string, decisionId: string) {
  const db = env.DB;
  if (!db) throw new Error("DB binding required");
  const row = await db.prepare(
    `SELECT * FROM decisions WHERE tenant = ? AND id = ?`
  )
    .bind(tenant, decisionId)
    .first<any>();
  return row;
}

export async function listDecisions(env: Env, id: Identity, limit = 50) {
  if (!env.DB) return [];
  const rows = await env.DB.prepare(
    `SELECT * FROM decisions
     WHERE tenant = ?
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(id.tenant, limit)
    .all();

  return (rows.results ?? []).map((r: any) => ({
    ...r,
    alternatives: JSON.parse(r.alternatives ?? "[]"),
    kpis: JSON.parse(r.kpis ?? "[]"),
  }));
}

export async function getDecisionDetail(env: Env, id: Identity, decisionId: string) {
  if (!env.DB) throw new Error("DB binding required");

  const decision = await getDecision(env, id.tenant, decisionId);
  if (!decision) return null;

  const evidence = await env.DB.prepare(
    `SELECT * FROM decision_evidence
     WHERE tenant = ? AND decision_id = ?
     ORDER BY created_at DESC`
  )
    .bind(id.tenant, decisionId)
    .all();

  const feedback = await env.DB.prepare(
    `SELECT * FROM decision_feedback
     WHERE tenant = ? AND decision_id = ?
     ORDER BY created_at DESC`
  )
    .bind(id.tenant, decisionId)
    .all();

  return {
    ...decision,
    alternatives: JSON.parse(decision.alternatives ?? "[]"),
    kpis: JSON.parse(decision.kpis ?? "[]"),
    evidence: evidence.results ?? [],
    feedback: feedback.results ?? [],
  };
}

export async function addEvidence(
  env: Env,
  id: Identity,
  decisionId: string,
  input: {
    evidence_type: string;
    reference_id: string;
    label?: string;
    metadata?: Record<string, unknown>;
  }
) {
  if (!env.DB) throw new Error("DB binding required");
  if (!input?.evidence_type || !input?.reference_id) {
    throw new Error("evidence_type y reference_id son requeridos");
  }

  const decision = await getDecision(env, id.tenant, decisionId);
  if (!decision) throw new Error("decision not found");

  const evidenceId = `ev_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO decision_evidence
       (id, decision_id, tenant, evidence_type, reference_id, label, metadata, added_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      evidenceId,
      decisionId,
      id.tenant,
      input.evidence_type,
      input.reference_id,
      input.label ?? null,
      JSON.stringify(input.metadata ?? {}),
      id.actor,
      Date.now()
    )
    .run();

  await emitLineage(env, {
    object_id: decisionId,
    parent_ids: [input.reference_id],
    transformation: "decision.evidence.added",
    pipeline_version: "v1",
    actor: id.actor,
    metadata: { evidence_type: input.evidence_type },
  });

  return { evidence_id: evidenceId };
}

export async function decideDecision(
  env: Env,
  id: Identity,
  decisionId: string,
  input: { approve: boolean; reason?: string }
) {
  if (!env.DB) throw new Error("DB binding required");

  const decision = await getDecision(env, id.tenant, decisionId);
  if (!decision) throw new Error("decision not found");

  const access = await evaluateAccess(env, id, {
    action: "execute",
    object_type: "decision",
    purpose: "decision",
    resource_id: decisionId,
  });

  if (access.effect === "deny") {
    throw new Error(`access_denied:${access.reason}`);
  }

  const status = input.approve ? "approved" : "rejected";
  await env.DB.prepare(
    `UPDATE decisions
     SET status = ?, updated_at = ?
     WHERE tenant = ? AND id = ?`
  )
    .bind(status, Date.now(), id.tenant, decisionId)
    .run();

  await emitLineage(env, {
    object_id: decisionId,
    transformation: input.approve ? "decision.approved" : "decision.rejected",
    pipeline_version: "v1",
    actor: id.actor,
    metadata: { reason: input.reason ?? null },
  });

  return { decision_id: decisionId, status };
}

export async function recordOutcome(
  env: Env,
  id: Identity,
  decisionId: string,
  input: { outcome: string; feedback?: string; score?: number; measured_at?: number }
) {
  if (!env.DB) throw new Error("DB binding required");
  if (!input?.outcome) throw new Error("outcome requerido");

  const decision = await getDecision(env, id.tenant, decisionId);
  if (!decision) throw new Error("decision not found");

  const feedbackId = `fb_${crypto.randomUUID()}`;
  const measuredAt = input.measured_at ?? Date.now();

  await env.DB.prepare(
    `INSERT INTO decision_feedback
       (id, decision_id, tenant, outcome, feedback, score, measured_at, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      feedbackId,
      decisionId,
      id.tenant,
      input.outcome,
      input.feedback ?? null,
      input.score ?? null,
      measuredAt,
      id.actor,
      Date.now()
    )
    .run();

  await env.DB.prepare(
    `UPDATE decisions
     SET status = 'closed', updated_at = ?
     WHERE tenant = ? AND id = ?`
  )
    .bind(Date.now(), id.tenant, decisionId)
    .run();

  await emitLineage(env, {
    object_id: decisionId,
    transformation: "decision.outcome.recorded",
    pipeline_version: "v1",
    actor: id.actor,
    metadata: { outcome: input.outcome, score: input.score ?? null },
  });

  return { feedback_id: feedbackId, status: "closed" };
}

export async function handleDecisions(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
  if (path === "/v1/decisions" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    try {
      return json({ ok: true, ...(await createDecision(env, identity, body)) });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 400);
    }
  }

  if (path === "/v1/decisions" && req.method === "GET") {
    const items = await listDecisions(env, identity);
    return json({ ok: true, items });
  }

  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "v1" && parts[1] === "decisions" && parts[2]) {
    const decisionId = decodeURIComponent(parts[2]);
    const sub = parts[3];

    if (!sub && req.method === "GET") {
      const decision = await getDecisionDetail(env, identity, decisionId);
      if (!decision) return json({ ok: false, error: "decision not found" }, 404);
      return json({ ok: true, decision });
    }

    if (sub === "evidence" && req.method === "POST") {
      const body = await req.json<any>().catch(() => ({}));
      try {
        return json({ ok: true, ...(await addEvidence(env, identity, decisionId, body)) });
      } catch (e: any) {
        return json({ ok: false, error: String(e?.message || e) }, 400);
      }
    }

    if (sub === "approve" && req.method === "POST") {
      const body = await req.json<any>().catch(() => ({}));
      try {
        return json({
          ok: true,
          ...(await decideDecision(env, identity, decisionId, {
            approve: body?.approve !== false,
            reason: body?.reason,
          })),
        });
      } catch (e: any) {
        return json({ ok: false, error: String(e?.message || e) }, 400);
      }
    }

    if (sub === "outcome" && req.method === "POST") {
      const body = await req.json<any>().catch(() => ({}));
      try {
        return json({ ok: true, ...(await recordOutcome(env, identity, decisionId, body)) });
      } catch (e: any) {
        return json({ ok: false, error: String(e?.message || e) }, 400);
      }
    }
  }

  return null;
}

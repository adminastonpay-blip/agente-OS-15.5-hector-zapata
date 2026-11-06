import type { Env, Identity } from "../types";
import { emitLineage } from "../lineage";
import { evaluateAccess } from "../access/access";

export type PlanStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "executing"
  | "completed"
  | "failed";

export type GovernedAction = {
  action: string;
  object_type: string;
  target_id?: string;
  payload?: Record<string, unknown>;
  estimated_cost?: number;
};

export async function createPlan(
  env: Env,
  id: Identity,
  input: {
    goal: string;
    agent_id?: string;
    steps: GovernedAction[];
    budget_calls?: number;
    budget_cost?: number;
  }
) {
  if (!env.DB) throw new Error("DB binding required");
  if (!input?.goal || !Array.isArray(input.steps) || !input.steps.length) {
    throw new Error("goal y steps son requeridos");
  }

  const access = await evaluateAccess(env, id, {
    action: "create",
    object_type: "agent_plan",
    purpose: "agent",
  });

  if (access.effect === "deny") {
    throw new Error(`access_denied:${access.reason}`);
  }

  const planId = `plan_${crypto.randomUUID()}`;
  const now = Date.now();
  const budgetCalls = Math.max(1, Math.min(input.budget_calls ?? 10, 100));
  const budgetCost = Math.max(0, input.budget_cost ?? 0);

  await env.DB.prepare(
    `INSERT INTO agent_plans
       (id, tenant, agent_id, goal, status, budget_calls, budget_cost, used_calls, used_cost, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending_approval', ?, ?, 0, 0, ?, ?, ?)`
  )
    .bind(
      planId,
      id.tenant,
      input.agent_id ?? "default-agent",
      input.goal,
      budgetCalls,
      budgetCost,
      id.actor,
      now,
      now
    )
    .run();

  for (const step of input.steps) {
    await env.DB.prepare(
      `INSERT INTO agent_actions
         (id, plan_id, tenant, action, object_type, target_id, payload, estimated_cost, status, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`
    )
      .bind(
        `act_${crypto.randomUUID()}`,
        planId,
        id.tenant,
        step.action,
        step.object_type,
        step.target_id ?? null,
        JSON.stringify(step.payload ?? {}),
        step.estimated_cost ?? 0,
        id.actor,
        now
      )
      .run();
  }

  await emitLineage(env, {
    object_id: planId,
    transformation: "agent.plan.created",
    pipeline_version: "v1",
    actor: id.actor,
    metadata: { goal: input.goal, steps: input.steps.length },
  });

  return {
    plan_id: planId,
    status: "pending_approval",
    budget_calls: budgetCalls,
    budget_cost: budgetCost,
  };
}

async function getPlan(env: Env, tenant: string, planId: string) {
  return env.DB.prepare(
    `SELECT * FROM agent_plans WHERE tenant = ? AND id = ?`
  )
    .bind(tenant, planId)
    .first<any>();
}

export async function listPlans(env: Env, id: Identity, limit = 50) {
  if (!env.DB) return [];
  const rows = await env.DB.prepare(
    `SELECT * FROM agent_plans
     WHERE tenant = ?
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(id.tenant, limit)
    .all();
  return rows.results ?? [];
}

export async function getPlanDetail(env: Env, id: Identity, planId: string) {
  if (!env.DB) throw new Error("DB binding required");

  const plan = await getPlan(env, id.tenant, planId);
  if (!plan) return null;

  const actions = await env.DB.prepare(
    `SELECT * FROM agent_actions
     WHERE tenant = ? AND plan_id = ?
     ORDER BY created_at`
  )
    .bind(id.tenant, planId)
    .all();

  return {
    ...plan,
    actions: (actions.results ?? []).map((a: any) => ({
      ...a,
      payload: JSON.parse(a.payload ?? "{}"),
    })),
  };
}

export async function approvePlan(
  env: Env,
  id: Identity,
  planId: string,
  input: { approve: boolean; reason?: string }
) {
  if (!env.DB) throw new Error("DB binding required");

  const plan = await getPlan(env, id.tenant, planId);
  if (!plan) throw new Error("plan not found");

  const access = await evaluateAccess(env, id, {
    action: "execute",
    object_type: "agent_plan",
    purpose: "agent",
    resource_id: planId,
  });

  if (access.effect === "deny") {
    throw new Error(`access_denied:${access.reason}`);
  }

  const status = input.approve ? "approved" : "rejected";
  await env.DB.prepare(
    `UPDATE agent_plans
     SET status = ?, updated_at = ?
     WHERE tenant = ? AND id = ?`
  )
    .bind(status, Date.now(), id.tenant, planId)
    .run();

  await emitLineage(env, {
    object_id: planId,
    transformation: input.approve ? "agent.plan.approved" : "agent.plan.rejected",
    pipeline_version: "v1",
    actor: id.actor,
    metadata: { reason: input.reason ?? null },
  });

  return { plan_id: planId, status };
}

export async function executePlan(env: Env, id: Identity, planId: string) {
  if (!env.DB) throw new Error("DB binding required");

  const plan = await getPlan(env, id.tenant, planId);
  if (!plan) throw new Error("plan not found");
  if (plan.status !== "approved") {
    throw new Error(`plan_not_approved:${plan.status}`);
  }

  const access = await evaluateAccess(env, id, {
    action: "execute",
    object_type: "agent_plan",
    purpose: "agent",
    resource_id: planId,
  });

  if (access.effect === "deny") {
    throw new Error(`access_denied:${access.reason}`);
  }

  await env.DB.prepare(
    `UPDATE agent_plans SET status = 'executing', updated_at = ?
     WHERE tenant = ? AND id = ?`
  )
    .bind(Date.now(), id.tenant, planId)
    .run();

  const actions = await env.DB.prepare(
    `SELECT * FROM agent_actions
     WHERE tenant = ? AND plan_id = ? AND status = 'proposed'
     ORDER BY created_at`
  )
    .bind(id.tenant, planId)
    .all();

  let usedCalls = plan.used_calls ?? 0;
  let usedCost = plan.used_cost ?? 0;
  let failed = false;
  let failureReason = "";

  for (const action of (actions.results ?? []) as any[]) {
    if (usedCalls >= plan.budget_calls) {
      failed = true;
      failureReason = "budget_calls_exhausted";
      break;
    }

    const estimatedCost = Number(action.estimated_cost ?? 0);
    if (plan.budget_cost > 0 && usedCost + estimatedCost > plan.budget_cost) {
      failed = true;
      failureReason = "budget_cost_exhausted";
      break;
    }

    const accessAction =
      action.action === "create"
        ? "create"
        : action.action === "update"
          ? "update"
          : action.action === "delete"
            ? "delete"
            : "execute";

    const actionAccess = await evaluateAccess(env, id, {
      action: accessAction as any,
      object_type: action.object_type,
      purpose: "agent",
      resource_id: action.target_id ?? action.id,
    });

    if (actionAccess.effect === "deny") {
      await env.DB.prepare(
        `UPDATE agent_actions
         SET status = 'blocked', result = ?, executed_at = ?
         WHERE id = ?`
      )
        .bind(`access_denied:${actionAccess.reason}`, Date.now(), action.id)
        .run();

      failed = true;
      failureReason = `action_blocked:${action.id}`;
      break;
    }

    // Ejecución gobernada: deja el punto de integración listo para APIs reales.
    const result = {
      simulated: true,
      action: action.action,
      object_type: action.object_type,
      target_id: action.target_id ?? null,
      access_decision_id: actionAccess.decision_id,
    };

    await env.DB.prepare(
      `UPDATE agent_actions
       SET status = 'executed', result = ?, executed_at = ?
       WHERE id = ?`
    )
      .bind(JSON.stringify(result), Date.now(), action.id)
      .run();

    usedCalls += 1;
    usedCost += estimatedCost;

    await emitLineage(env, {
      object_id: planId,
      parent_ids: action.target_id ? [action.target_id] : [],
      transformation: "agent.action.executed",
      pipeline_version: "v1",
      actor: id.actor,
      metadata: { action_id: action.id, action: action.action },
    });
  }

  const finalStatus = failed ? "failed" : "completed";
  await env.DB.prepare(
    `UPDATE agent_plans
     SET status = ?, used_calls = ?, used_cost = ?, updated_at = ?
     WHERE tenant = ? AND id = ?`
  )
    .bind(finalStatus, usedCalls, usedCost, Date.now(), id.tenant, planId)
    .run();

  return {
    plan_id: planId,
    status: finalStatus,
    used_calls: usedCalls,
    used_cost: usedCost,
    failure_reason: failureReason || null,
  };
}

export async function handleGovernedAgents(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
  if (path === "/v1/agents/plans" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    try {
      return json({ ok: true, ...(await createPlan(env, identity, body)) });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 400);
    }
  }

  if (path === "/v1/agents/plans" && req.method === "GET") {
    const items = await listPlans(env, identity);
    return json({ ok: true, items });
  }

  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "v1" && parts[1] === "agents" && parts[2] === "plans" && parts[3]) {
    const planId = decodeURIComponent(parts[3]);
    const sub = parts[4];

    if (!sub && req.method === "GET") {
      const plan = await getPlanDetail(env, identity, planId);
      if (!plan) return json({ ok: false, error: "plan not found" }, 404);
      return json({ ok: true, plan });
    }

    if (sub === "approve" && req.method === "POST") {
      const body = await req.json<any>().catch(() => ({}));
      try {
        return json({
          ok: true,
          ...(await approvePlan(env, identity, planId, {
            approve: body?.approve !== false,
            reason: body?.reason,
          })),
        });
      } catch (e: any) {
        return json({ ok: false, error: String(e?.message || e) }, 400);
      }
    }

    if (sub === "execute" && req.method === "POST") {
      try {
        return json({ ok: true, ...(await executePlan(env, identity, planId)) });
      } catch (e: any) {
        return json({ ok: false, error: String(e?.message || e) }, 400);
      }
    }
  }

  return null;
}

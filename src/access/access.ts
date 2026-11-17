import type { Env, Identity } from "../types";
import { emitLineage } from "../lineage";

export type AccessAction = "read" | "create" | "update" | "delete" | "execute";
export type AccessEffect = "allow" | "deny" | "require_approval";

const CLEARANCE_RANK: Record<string, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3,
};

export type AccessPolicyInput = {
  name: string;
  role?: string;
  object_type?: string;
  action?: AccessAction;
  purpose?: string;
  clearance?: string;
  effect?: AccessEffect;
  row_filter?: Record<string, unknown[]>;
  restricted_fields?: string[];
  priority?: number;
};

export async function upsertPolicy(
  env: Env,
  id: Identity,
  input: AccessPolicyInput & { id?: string }
) {
  if (!env.DB) throw new Error("DB binding required");
  if (!input?.name) throw new Error("name requerido");

  const policyId = input.id || `pol_${crypto.randomUUID()}`;
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO access_policies
       (id, tenant, name, role, object_type, action, purpose, clearance, effect,
        row_filter, restricted_fields, priority, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       role=excluded.role,
       object_type=excluded.object_type,
       action=excluded.action,
       purpose=excluded.purpose,
       clearance=excluded.clearance,
       effect=excluded.effect,
       row_filter=excluded.row_filter,
       restricted_fields=excluded.restricted_fields,
       priority=excluded.priority`
  )
    .bind(
      policyId,
      id.tenant,
      input.name,
      input.role ?? "*",
      input.object_type ?? "*",
      input.action ?? "read",
      input.purpose ?? "*",
      input.clearance ?? "*",
      input.effect ?? "allow",
      input.row_filter ? JSON.stringify(input.row_filter) : null,
      input.restricted_fields ? JSON.stringify(input.restricted_fields) : null,
      input.priority ?? 100,
      id.actor,
      now
    )
    .run();

  await emitLineage(env, {
    object_id: policyId,
    transformation: "access.policy.upsert",
    pipeline_version: "v1",
    actor: id.actor,
    metadata: { name: input.name, effect: input.effect ?? "allow" },
  });

  return { policy_id: policyId };
}

export async function listPolicies(env: Env, id: Identity, limit = 100) {
  if (!env.DB) return [];
  const rows = await env.DB.prepare(
    `SELECT * FROM access_policies
     WHERE tenant = ?
     ORDER BY priority DESC, created_at DESC
     LIMIT ?`
  )
    .bind(id.tenant, limit)
    .all();

  return (rows.results ?? []).map((r: any) => ({
    ...r,
    row_filter: r.row_filter ? JSON.parse(r.row_filter) : null,
    restricted_fields: r.restricted_fields ? JSON.parse(r.restricted_fields) : [],
  }));
}

function policyMatches(
  policy: any,
  identity: Identity,
  request: { action: AccessAction; object_type: string; purpose: string }
) {
  const roleOk =
    policy.role === "*" || identity.roles.includes(policy.role);
  const typeOk =
    policy.object_type === "*" || policy.object_type === request.object_type;
  const actionOk =
    policy.action === "*" || policy.action === request.action;
  const purposeOk =
    policy.purpose === "*" || policy.purpose === request.purpose;

  const requiredRank = CLEARANCE_RANK[policy.clearance] ?? 0;
  const identityRank = CLEARANCE_RANK[identity.clearance] ?? 0;
  const clearanceOk = policy.clearance === "*" || identityRank >= requiredRank;

  return roleOk && typeOk && actionOk && purposeOk && clearanceOk;
}

export async function evaluateAccess(
  env: Env,
  identity: Identity,
  request: {
    action: AccessAction;
    object_type: string;
    purpose?: string;
    resource_id?: string;
  }
) {
  if (!env.DB) throw new Error("DB binding required");

  const purpose = request.purpose || "read";
  const rows = await env.DB.prepare(
    `SELECT * FROM access_policies
     WHERE tenant = ?
     ORDER BY priority DESC`
  )
    .bind(identity.tenant)
    .all();

  const policies = (rows.results ?? []) as any[];
  const matched = policies.find((p) =>
    policyMatches(p, identity, {
      action: request.action,
      object_type: request.object_type,
      purpose,
    })
  );

  const effect: AccessEffect = matched ? matched.effect : "deny";
  const reason = matched
    ? `matched_policy:${matched.id}`
    : "no_matching_policy_default_deny";

  const decisionId = `dec_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO access_decisions
       (id, tenant, actor, action, object_type, purpose, effect, policy_id, reason, resource_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      decisionId,
      identity.tenant,
      identity.actor,
      request.action,
      request.object_type,
      purpose,
      effect,
      matched?.id ?? null,
      reason,
      request.resource_id ?? null,
      Date.now()
    )
    .run();

  return {
    decision_id: decisionId,
    effect,
    reason,
    policy_id: matched?.id ?? null,
  };
}

function redactProperties(
  properties: Record<string, unknown>,
  restrictedFields: string[],
  identity: Identity
) {
  const canSeeRestricted =
    identity.roles.includes("admin") ||
    (CLEARANCE_RANK[identity.clearance] ?? 0) >= CLEARANCE_RANK.confidential;

  if (canSeeRestricted || !restrictedFields.length) return properties;

  const out: Record<string, unknown> = { ...properties };
  for (const field of restrictedFields) {
    if (field in out) out[field] = "***";
  }
  return out;
}

function passesRowFilter(
  properties: Record<string, unknown>,
  rowFilter: Record<string, unknown[]> | null
) {
  if (!rowFilter) return true;

  for (const [field, allowed] of Object.entries(rowFilter)) {
    const value = properties?.[field];
    if (!Array.isArray(allowed) || !allowed.includes(value)) return false;
  }
  return true;
}

export async function secureReadObjects(
  env: Env,
  identity: Identity,
  options: { type_id?: string; purpose?: string; limit?: number }
) {
  if (!env.DB) throw new Error("DB binding required");

  const evaluation = await evaluateAccess(env, identity, {
    action: "read",
    object_type: options.type_id || "*",
    purpose: options.purpose || "read",
  });

  // Only an explicit allow may release protected records. A pending approval
  // is not an authorization to read; the data must remain undisclosed.
  if (evaluation.effect !== "allow") {
    return {
      allowed: false,
      effect: evaluation.effect,
      reason: evaluation.reason,
      decision_id: evaluation.decision_id,
      items: [],
    };
  }

  const limit = Math.min(options.limit ?? 100, 200);
  const rows = options.type_id
    ? await env.DB.prepare(
        `SELECT * FROM objects
         WHERE tenant = ? AND type_id = ? AND valid_to IS NULL
         ORDER BY created_at DESC LIMIT ?`
      )
        .bind(identity.tenant, options.type_id, limit)
        .all()
    : await env.DB.prepare(
        `SELECT * FROM objects
         WHERE tenant = ? AND valid_to IS NULL
         ORDER BY created_at DESC LIMIT ?`
      )
        .bind(identity.tenant, limit)
        .all();

  const policies = await listPolicies(env, identity, 200);
  const relevant = policies.filter(
    (p) =>
      p.effect === "allow" &&
      (p.object_type === "*" || p.object_type === options.type_id) &&
      (p.action === "*" || p.action === "read")
  );

  const items = (rows.results ?? [])
    .map((r: any) => {
      const properties = JSON.parse(r.properties ?? "{}");
      const allowed = relevant.some((p) => passesRowFilter(properties, p.row_filter));
      if (!allowed) return null;

      const restricted = relevant.flatMap((p) => p.restricted_fields ?? []);
      return {
        id: r.id,
        type_id: r.type_id,
        properties: redactProperties(properties, restricted, identity),
        version: r.version,
        created_at: r.created_at,
      };
    })
    .filter(Boolean);

  return {
    allowed: true,
    decision_id: evaluation.decision_id,
    items,
  };
}

export async function handleAccess(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
  if (path === "/v1/access/policies" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    try {
      const result = await upsertPolicy(env, identity, body);
      return json({ ok: true, ...result });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 400);
    }
  }

  if (path === "/v1/access/policies" && req.method === "GET") {
    const items = await listPolicies(env, identity);
    return json({ ok: true, items });
  }

  if (path === "/v1/access/evaluate" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    try {
      const result = await evaluateAccess(env, identity, body);
      return json({ ok: true, ...result });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 400);
    }
  }

  if (path === "/v1/ontology/objects/secure" && req.method === "GET") {
    const url = new URL(req.url);
    const result = await secureReadObjects(env, identity, {
      type_id: url.searchParams.get("type_id") || undefined,
      purpose: url.searchParams.get("purpose") || undefined,
      limit: Number(url.searchParams.get("limit") || 100),
    });
    return json({ ok: true, ...result });
  }

  return null;
}

import type { Env, Identity } from "../types";
import { emitLineage } from "../lineage";

export type JsonSchema = {
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
};

export async function registerSchema(
  env: Env,
  id: Identity,
  input: { type_id?: string; name?: string; json_schema: JsonSchema }
) {
  if (!env.DB) throw new Error("DB binding required");
  if (!input?.json_schema || typeof input.json_schema !== "object") {
    throw new Error("json_schema requerido");
  }

  const typeId = input.type_id || `ot_${crypto.randomUUID()}`;
  const now = Date.now();

  const row = await env.DB.prepare(
    `SELECT COALESCE(MAX(version), 0) AS v
     FROM object_type_versions
     WHERE tenant = ? AND type_id = ?`
  )
    .bind(id.tenant, typeId)
    .first<any>();

  const version = Number(row?.v ?? 0) + 1;
  const schemaId = `ots_${crypto.randomUUID()}`;

  await env.DB.prepare(
    `INSERT INTO object_type_versions
       (id, tenant, type_id, version, json_schema, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`
  )
    .bind(schemaId, id.tenant, typeId, version, JSON.stringify(input.json_schema), id.actor, now)
    .run();

  await env.DB.prepare(
    `UPDATE object_type_versions
     SET status = 'deprecated'
     WHERE tenant = ? AND type_id = ? AND status = 'active'`
  )
    .bind(id.tenant, typeId)
    .run();

  await env.DB.prepare(
    `UPDATE object_type_versions SET status = 'active' WHERE id = ?`
  )
    .bind(schemaId)
    .run();

  await emitLineage(env, {
    tenant: id.tenant,
    object_id: typeId,
    transformation: "ontology.schema.register",
    pipeline_version: "v1",
    actor: id.actor,
    metadata: { version, schema_id: schemaId },
  });

  return { schema_id: schemaId, type_id: typeId, version, status: "active" };
}

export async function getActiveSchema(env: Env, tenant: string, typeId: string) {
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    `SELECT * FROM object_type_versions
     WHERE tenant = ? AND type_id = ? AND status = 'active'
     ORDER BY version DESC LIMIT 1`
  )
    .bind(tenant, typeId)
    .first<any>();

  if (!row) return null;
  return {
    schema_id: row.id,
    type_id: row.type_id,
    version: row.version,
    status: row.status,
    json_schema: JSON.parse(row.json_schema),
    created_at: row.created_at,
  };
}

export function validateProperties(schema: JsonSchema, properties: Record<string, unknown>) {
  const errors: string[] = [];
  const props = schema?.properties ?? {};
  const required = schema?.required ?? [];

  for (const key of required) {
    const value = properties?.[key];
    if (value === undefined || value === null || value === "") {
      errors.push(`missing:${key}`);
    }
  }

  for (const [key, rule] of Object.entries(props)) {
    const value = properties?.[key];
    if (value === undefined || value === null) continue;

    const t = rule?.type;
    const typeOk =
      !t ||
      (t === "string" && typeof value === "string") ||
      (t === "number" && typeof value === "number" && Number.isFinite(value)) ||
      (t === "boolean" && typeof value === "boolean") ||
      (t === "object" && typeof value === "object" && !Array.isArray(value)) ||
      (t === "array" && Array.isArray(value));

    if (!typeOk) errors.push(`type:${key}`);

    if (t === "string" && typeof value === "string" && rule?.pattern) {
      try {
        if (!new RegExp(rule.pattern).test(value)) errors.push(`pattern:${key}`);
      } catch {
        errors.push(`invalid_pattern:${key}`);
      }
    }

    if (typeof value === "number") {
      if (rule?.minimum !== undefined && value < rule.minimum) errors.push(`minimum:${key}`);
      if (rule?.maximum !== undefined && value > rule.maximum) errors.push(`maximum:${key}`);
    }

    if (Array.isArray(rule?.enum) && !rule.enum.includes(value)) {
      errors.push(`enum:${key}`);
    }
  }

  const checked = Object.keys(props).length || 1;
  const passed = Math.max(0, checked - errors.length);
  const quality_score = Math.max(0, Math.min(1, passed / checked));

  return { ok: errors.length === 0, errors, quality_score };
}

export async function quarantineObject(
  env: Env,
  id: Identity,
  o: { type_id: string; properties: Record<string, unknown>; source?: string },
  errors: string[],
  qualityScore: number
) {
  if (!env.DB) throw new Error("DB binding required");
  const qid = `q_${crypto.randomUUID()}`;
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO quarantine_objects
       (id, tenant, type_id, properties, errors, quality_score, source, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      qid,
      id.tenant,
      o.type_id,
      JSON.stringify(o.properties ?? {}),
      JSON.stringify(errors),
      qualityScore,
      o.source ?? null,
      id.actor,
      now
    )
    .run();

  await emitLineage(env, {
    tenant: id.tenant,
    object_id: qid,
    transformation: "ontology.object.quarantined",
    pipeline_version: "v1",
    actor: id.actor,
    metadata: { type_id: o.type_id, errors, quality_score: qualityScore },
  });

  return qid;
}

export async function listQuarantine(env: Env, id: Identity, limit = 50) {
  if (!env.DB) return [];
  const rows = await env.DB.prepare(
    `SELECT * FROM quarantine_objects
     WHERE tenant = ?
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(id.tenant, limit)
    .all();

  return (rows.results ?? []).map((r: any) => ({
    ...r,
    properties: JSON.parse(r.properties ?? "{}"),
    errors: JSON.parse(r.errors ?? "[]"),
  }));
}

export async function handleTrust(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
  if (path === "/v1/ontology/schema" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    try {
      const result = await registerSchema(env, identity, body);
      return json({ ok: true, ...result });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 400);
    }
  }

  if (path.startsWith("/v1/ontology/schema/") && req.method === "GET") {
    const typeId = decodeURIComponent(path.split("/").pop() || "");
    const schema = await getActiveSchema(env, identity.tenant, typeId);
    if (!schema) return json({ ok: false, error: "schema not found" }, 404);
    return json({ ok: true, schema });
  }

  if (path === "/v1/ontology/objects/validated" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    try {
      const { createValidatedObject } = await import("../ontology");
      const result = await createValidatedObject(env, identity, body);
      return json({ ok: true, ...result });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 400);
    }
  }

  if (path === "/v1/ontology/quarantine" && req.method === "GET") {
    const items = await listQuarantine(env, identity);
    return json({ ok: true, items });
  }

  return null;
}

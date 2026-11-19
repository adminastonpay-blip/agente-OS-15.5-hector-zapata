import type { Env, Identity } from "./types";
import { emitLineage } from "./lineage";
import { getActiveSchema, validateProperties, quarantineObject } from "./ontology/trust";

export async function createObjectType(env: Env, t: { name: string; schema: unknown }) {
  if (!env.DB) throw new Error("DB binding required");
  const id = `ot_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO object_types (id, name, properties, created_at) VALUES (?, ?, ?, ?)`
  )
    .bind(id, t.name, JSON.stringify(t.schema), Date.now())
    .run();
  return id;
}

export async function createObject(
  env: Env,
  id: Identity,
  o: { type_id: string; properties: Record<string, unknown> }
) {
  if (!env.DB) throw new Error("DB binding required");
  const oid = `obj_${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO objects (id, type_id, tenant, properties, version, valid_from, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  )
    .bind(oid, o.type_id, id.tenant, JSON.stringify(o.properties), now, now)
    .run();

  await emitLineage(env, {
    tenant: id.tenant,
    object_id: oid,
    transformation: "create_object",
    pipeline_version: "v1",
    actor: id.actor,
    metadata: { type_id: o.type_id },
  });

  if (env.GRAPH) {
    try {
      const stub = env.GRAPH.get(env.GRAPH.idFromName(id.tenant));
      await stub.fetch("https://do/object", {
        method: "POST",
        body: JSON.stringify({ id: oid, type_id: o.type_id, properties: o.properties }),
      });
    } catch {
      /* graph sync best-effort */
    }
  }
  return oid;
}

export async function createValidatedObject(
  env: Env,
  id: Identity,
  o: {
    type_id: string;
    properties: Record<string, unknown>;
    source?: string;
  }
) {
  if (!env.DB) throw new Error("DB binding required");

  const schema = await getActiveSchema(env, id.tenant, o.type_id);
  if (!schema) {
    throw new Error(`no active schema for type ${o.type_id}`);
  }

  const validation = validateProperties(schema.json_schema, o.properties ?? {});

  if (!validation.ok) {
    const quarantineId = await quarantineObject(
      env,
      id,
      o,
      validation.errors,
      validation.quality_score
    );

    return {
      created: false,
      quarantined: true,
      quarantine_id: quarantineId,
      errors: validation.errors,
      quality_score: validation.quality_score,
    };
  }

  const objectId = await createObject(env, id, o);

  return {
    created: true,
    object_id: objectId,
    quality_score: validation.quality_score,
  };
}

export async function createLink(
  env: Env,
  id: Identity,
  l: { from_id: string; to_id: string; type: string; properties?: Record<string, unknown> }
) {
  if (!env.DB) throw new Error("DB binding required");
  // A link is tenant-owned. Both endpoints must already belong to the
  // caller's tenant; never create a cross-tenant nested reference.
  const [fromObject, toObject] = await Promise.all([
    env.DB.prepare("SELECT id FROM objects WHERE tenant = ? AND id = ?")
      .bind(id.tenant, l.from_id).first(),
    env.DB.prepare("SELECT id FROM objects WHERE tenant = ? AND id = ?")
      .bind(id.tenant, l.to_id).first(),
  ]);
  if (!fromObject || !toObject) {
    throw new Error("link endpoints must belong to caller tenant");
  }

  const lid = `lnk_${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO links (id, tenant, from_id, to_id, type, properties, version, valid_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  )
    .bind(lid, id.tenant, l.from_id, l.to_id, l.type, JSON.stringify(l.properties ?? {}), now, now)
    .run();

  await emitLineage(env, {
    tenant: id.tenant,
    object_id: lid,
    parent_ids: [l.from_id, l.to_id],
    transformation: "create_link",
    pipeline_version: "v1",
    actor: id.actor,
    metadata: { type: l.type },
  });

  if (env.GRAPH) {
    try {
      const stub = env.GRAPH.get(env.GRAPH.idFromName(id.tenant));
      await stub.fetch("https://do/link", {
        method: "POST",
        body: JSON.stringify({ id: lid, from_id: l.from_id, to_id: l.to_id, type: l.type }),
      });
    } catch {
      /* best-effort */
    }
  }
  return lid;
}

export async function findObjectsByProperty(
  env: Env,
  id: Identity,
  type_id: string,
  key: string,
  value: unknown
) {
  if (!env.DB) return [];
  const rows = await env.DB.prepare(
    `SELECT * FROM objects WHERE tenant = ? AND type_id = ?
     AND json_extract(properties, ?) = ? AND valid_to IS NULL`
  )
    .bind(id.tenant, type_id, `$.${key}`, value)
    .all();
  return rows.results;
}

export async function cascadeImpact(
  env: Env,
  tenant: string,
  rootId: string,
  atTs: number
) {
  if (!env.DB) return [];

  const out: { to_id: string; type: string; depth: number }[] = [];
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  let depth = 0;

  while (frontier.length && depth < 5) {
    depth++;
    const next: string[] = [];
    for (const from of frontier) {
      const rows = await env.DB.prepare(
        `SELECT to_id, type FROM links
         WHERE tenant = ? AND from_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
         LIMIT 50`
      )
        .bind(tenant, from, atTs, atTs)
        .all();
      for (const r of (rows.results ?? []) as any[]) {
        if (seen.has(r.to_id)) continue;
        seen.add(r.to_id);
        out.push({ to_id: r.to_id, type: r.type, depth });
        next.push(r.to_id);
      }
    }
    frontier = next;
  }

  return out;
}

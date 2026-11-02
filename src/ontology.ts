import type { Env, Identity } from "./types";
import { emitLineage } from "./lineage";

export async function createObjectType(env: Env, t: { name: string; schema: unknown }) {
  const id = `ot_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO object_types (id, name, properties, created_at) VALUES (?, ?, ?, ?)`
  ).bind(id, t.name, JSON.stringify(t.schema), Date.now()).run();
  return id;
}

export async function createObject(env: Env, id: Identity,
  o: { type_id: string; properties: Record<string, unknown> }) {
  const oid = `obj_${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO objects (id, type_id, tenant, properties, version, valid_from, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  ).bind(oid, o.type_id, id.tenant, JSON.stringify(o.properties), now, now).run();

  await emitLineage(env, {
    object_id: oid, transformation: "create_object", pipeline_version: "v1",
    actor: id.actor, metadata: { type_id: o.type_id },
  });

  const stub = env.GRAPH.get(env.GRAPH.idFromName(id.tenant));
  await stub.fetch("https://do/object", {
    method: "POST",
    body: JSON.stringify({ id: oid, type_id: o.type_id, properties: o.properties }),
  });
  return oid;
}

export async function createLink(env: Env, id: Identity,
  l: { from_id: string; to_id: string; type: string; properties?: Record<string, unknown> }) {
  const lid = `lnk_${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO links (id, from_id, to_id, type, properties, version, valid_from, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(lid, l.from_id, l.to_id, l.type, JSON.stringify(l.properties ?? {}), now, now).run();

  await emitLineage(env, {
    object_id: lid, parent_ids: [l.from_id, l.to_id],
    transformation: "create_link", pipeline_version: "v1",
    actor: id.actor, metadata: { type: l.type },
  });

  const stub = env.GRAPH.get(env.GRAPH.idFromName(id.tenant));
  await stub.fetch("https://do/link", {
    method: "POST",
    body: JSON.stringify({ id: lid, from_id: l.from_id, to_id: l.to_id, type: l.type }),
  });
  return lid;
}

export async function findObjectsByProperty(env: Env, id: Identity,
  type_id: string, key: string, value: unknown) {
  const rows = await env.DB.prepare(
    `SELECT * FROM objects WHERE tenant = ? AND type_id = ?
     AND json_extract(properties, ?) = ? AND valid_to IS NULL`
  ).bind(id.tenant, type_id, `$.${key}`, value).all();
  return rows.results;
}

// Consulta de impacto en cascada vía Hyperdrive (bitemporal, Postgres)
export async function cascadeImpact(env: Env, tenant: string, rootId: string, atTs: number) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    const sql = `
      WITH RECURSIVE impact AS (
        SELECT l.to_id, l.type, 1 AS depth, ARRAY[l.from_id, l.to_id] AS path
        FROM links l
        WHERE l.from_id = $1 AND l.tenant = $3
          AND l.valid_from <= $2 AND (l.valid_to IS NULL OR l.valid_to > $2)
          AND l.valid_to IS NULL
        UNION ALL
        SELECT l.to_id, l.type, i.depth + 1, i.path || l.to_id
        FROM links l JOIN impact i ON l.from_id = i.to_id
        WHERE i.depth < 5 AND NOT l.to_id = ANY(i.path) AND l.tenant = $3
          AND l.valid_from <= $2 AND (l.valid_to IS NULL OR l.valid_to > $2)
      )
      SELECT DISTINCT to_id, type, depth FROM impact ORDER BY depth, to_id`;
    const r = await client.query(sql, [rootId, atTs, tenant]);
    return r.rows;
  } finally { await client.end(); }
}

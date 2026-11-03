import type { Env, Identity } from "./types";
import { emitLineage } from "./lineage";

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
    object_id: oid,
    transformation: "create_object",
    pipeline_version: "v1",
    actor: id.actor,
    metadata: { type_id: o.type_id },
  });

  const stub = env.GRAPH.get(env.GRAPH.idFromName(id.tenant));
  await stub.fetch("https://do/object", {
    method: "POST",
    body: JSON.stringify({ id: oid, type_id: o.type_id, properties: o.properties }),
  });
  return oid;
}

export async function createLink(
  env: Env,
  id: Identity,
  l: { from_id: string; to_id: string; type: string; properties?: Record<string, unknown> }
) {
  if (!env.DB) throw new Error("DB binding required");
  const lid = `lnk_${crypto.randomUUID()}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO links (id, from_id, to_id, type, properties, version, valid_from, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  )
    .bind(lid, l.from_id, l.to_id, l.type, JSON.stringify(l.properties ?? {}), now, now)
    .run();

  await emitLineage(env, {
    object_id: lid,
    parent_ids: [l.from_id, l.to_id],
    transformation: "create_link",
    pipeline_version: "v1",
    actor: id.actor,
    metadata: { type: l.type },
  });

  const stub = env.GRAPH.get(env.GRAPH.idFromName(id.tenant));
  await stub.fetch("https://do/link", {
    method: "POST",
    body: JSON.stringify({ id: lid, from_id: l.from_id, to_id: l.to_id, type: l.type }),
  });
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

/** Impacto en cascada vía D1 (sin paquete pg / Hyperdrive). */
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
         WHERE from_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
         LIMIT 50`
      )
        .bind(from, atTs, atTs)
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

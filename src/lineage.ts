import type { Env } from "./types";

export async function emitLineage(
  env: Env,
  opts: {
    object_id: string;
    transformation: string;
    pipeline_version: string;
    model?: string;
    actor?: string;
    metadata?: Record<string, unknown>;
    parent_ids?: string[];
  }
): Promise<void> {
  if (!env.DB) return;
  const id = `lin_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO lineage_events
     (id, object_id, parent_ids, transformation, pipeline_version, model, actor, metadata, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      opts.object_id,
      JSON.stringify(opts.parent_ids ?? []),
      opts.transformation,
      opts.pipeline_version,
      opts.model ?? null,
      opts.actor ?? null,
      JSON.stringify(opts.metadata ?? {}),
      Date.now()
    )
    .run();
}

export async function getLineageTree(env: Env, objectId: string, depth = 5): Promise<any[]> {
  if (!env.DB) return [];
  const rows = await env.DB.prepare(
    `SELECT * FROM lineage_events WHERE object_id = ? ORDER BY ts DESC LIMIT ?`
  )
    .bind(objectId, depth * 10)
    .all();
  return rows.results ?? [];
}

import type { Env } from "./types";

export async function emitLineage(env: Env, e: {
  object_id: string; parent_ids?: string[]; transformation: string;
  pipeline_version: string; model?: string; actor: string;
  metadata?: Record<string, unknown>;
}) {
  await env.DB.prepare(
    `INSERT INTO lineage_events (id, object_id, parent_ids, transformation, pipeline_version, model, actor, metadata, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    `lin_${crypto.randomUUID()}`, e.object_id, JSON.stringify(e.parent_ids ?? []),
    e.transformation, e.pipeline_version, e.model ?? null, e.actor,
    JSON.stringify(e.metadata ?? {}), Date.now()
  ).run();
}

export async function getLineageTree(env: Env, object_id: string, depth = 5) {
  const seen = new Set<string>();
  const queue = [{ id: object_id, d: 0 }];
  const events: any[] = [];
  while (queue.length) {
    const { id, d } = queue.shift()!;
    if (seen.has(id) || d > depth) continue;
    seen.add(id);
    const rows = await env.DB.prepare(
      `SELECT * FROM lineage_events WHERE object_id = ? ORDER BY ts ASC`
    ).bind(id).all();
    for (const r of rows.results as any[]) {
      events.push(r);
      for (const p of JSON.parse(r.parent_ids || "[]")) queue.push({ id: p, d: d + 1 });
    }
  }
  return events;
}

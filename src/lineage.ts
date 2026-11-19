import type { Env } from "./types";

export async function emitLineage(
  env: Env,
  opts: {
    tenant: string;
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
  if (!opts.tenant || !opts.tenant.trim()) {
    throw new Error("lineage tenant required");
  }
  const id = `lin_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO lineage_events
     (id, tenant, object_id, parent_ids, transformation, pipeline_version, model, actor, metadata, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      opts.tenant,
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

export async function getLineageTree(
  env: Env,
  tenant: string,
  objectId: string,
  depth = 5
): Promise<any[]> {
  if (!env.DB || !tenant || !tenant.trim()) return [];
  const safeDepth = Number.isFinite(depth) ? Math.max(1, Math.min(Math.floor(depth), 20)) : 5;
  const rows = await env.DB.prepare(
    `SELECT * FROM lineage_events
     WHERE tenant = ? AND object_id = ?
     ORDER BY ts DESC LIMIT ?`
  )
    .bind(tenant, objectId, safeDepth * 10)
    .all();
  return rows.results ?? [];
}

import type { Env } from "./types";
import { emitLineage } from "./lineage";
import { embed, chunk } from "./lib/ai";

export async function handleETLQueue(batch: MessageBatch<any>, env: Env) {
  for (const msg of batch.messages) {
    try {
      const db = env.DB;
      const vectorize = env.VECTORIZE;
      if (!db || !vectorize) throw new Error("ETL requires DB and VECTORIZE bindings");
      const job = msg.body as any;
      if (!job || typeof job.tenant !== "string" || !job.tenant.trim()) throw new Error("ETL job tenant required");
      const rawId = `raw_${crypto.randomUUID()}`;
      await emitLineage(env, {
        tenant: job.tenant,
        object_id: rawId, transformation: `etl.${job.kind}.received`,
        pipeline_version: "v1", actor: job.actor,
        metadata: { source: job.source, len: job.text.length },
      });
      const normalized = job.text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
      const chunks = chunk(normalized);
      const vectors = await embed(env, chunks);
      const upserts = chunks.map((c, i) => ({
        id: `${job.source}#${i}-${crypto.randomUUID().slice(0, 8)}`,
        values: vectors[i],
        metadata: { source: job.source, chunk: c.slice(0, 500), tenant: job.tenant },
      }));
      await vectorize.upsert(upserts as any);
      for (const u of upserts) {
        await db.prepare(
          "INSERT OR REPLACE INTO documents (id, source, chunk, created_at, tenant) VALUES (?, ?, ?, ?, ?)"
        ).bind(u.id, u.metadata.source, u.metadata.chunk, Date.now(), job.tenant).run();
        await emitLineage(env, {
          tenant: job.tenant,
          object_id: u.id, parent_ids: [rawId], transformation: "etl.chunk.embed",
          pipeline_version: "v1", model: env.EMBED_MODEL, actor: job.actor,
          metadata: { source: job.source },
        });
      }
      msg.ack();
    } catch { msg.retry(); }
  }
}

export async function handleCron(env: Env) {
  const db = env.DB;
  const vectorize = env.VECTORIZE;
  if (!db || !vectorize) throw new Error("Cron ETL requires DB and VECTORIZE bindings");
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  // Only re-embed rows with explicit tenant ownership. Legacy rows stay excluded.
  const stale = await db.prepare(
    `SELECT id, source, chunk, tenant FROM documents
     WHERE created_at < ? AND tenant IS NOT NULL AND tenant != '' LIMIT 50`
  ).bind(cutoff).all();
  for (const d of stale.results as any[]) {
    if (typeof d.tenant !== "string" || !d.tenant.trim()) continue;
    const [v] = await embed(env, [d.chunk]);
    await vectorize.upsert([{
      id: d.id, values: v,
      metadata: { source: d.source, chunk: d.chunk.slice(0, 500), tenant: d.tenant },
    }] as any);
    await emitLineage(env, {
      tenant: d.tenant,
      object_id: d.id, transformation: "cron.reembed",
      pipeline_version: "v1", model: env.EMBED_MODEL, actor: "cron",
    });
  }
}

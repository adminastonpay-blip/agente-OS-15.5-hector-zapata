import type { Env } from "./types";
import { emitLineage } from "./lineage";
import { embed, chunk } from "./lib/ai";

function requireTenant(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).byteLength > 64) {
    throw new Error("ETL job requires a valid tenant from the trusted queue producer");
  }
  return value.trim();
}

export async function handleETLQueue(batch: MessageBatch<any>, env: Env) {
  for (const msg of batch.messages) {
    try {
      const db = env.DB;
      const vectorize = env.VECTORIZE;
      if (!db || !vectorize) throw new Error("ETL requires DB and VECTORIZE bindings");
      const job = msg.body as any;
      const tenant = requireTenant(job?.tenant);
      if (typeof job.text !== "string" || !job.text.trim()) throw new Error("ETL text required");
      const source = String(job.source || "queue").slice(0, 200);
      const actor = typeof job.actor === "string" ? job.actor : "trusted-queue";
      const rawId = `raw_${crypto.randomUUID()}`;
      await emitLineage(env, {
        tenant,
        object_id: rawId,
        transformation: `etl.${String(job.kind || "ingest")}.received`,
        pipeline_version: "v1",
        actor,
        metadata: { source, len: job.text.length },
      });
      const normalized = job.text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
      const chunks = chunk(normalized);
      const vectors = await embed(env, chunks);
      const upserts = chunks.map((value, i) => ({
        id: `${source}#${i}-${crypto.randomUUID().slice(0, 8)}`,
        values: vectors[i],
        namespace: tenant,
        metadata: { source, text: value.slice(0, 500), tenant },
      }));
      await vectorize.upsert(upserts as any);
      for (const item of upserts) {
        await db.prepare(
          "INSERT OR REPLACE INTO documents (id, source, chunk, created_at, tenant, index_status) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(item.id, source, item.metadata.text, Date.now(), tenant, "INDEXED").run();
        await emitLineage(env, {
          tenant,
          object_id: item.id,
          parent_ids: [rawId],
          transformation: "etl.chunk.embed",
          pipeline_version: "v1",
          model: env.EMBED_MODEL,
          actor,
          metadata: { source },
        });
      }
      msg.ack();
    } catch {
      msg.retry();
    }
  }
}

export async function handleCron(env: Env) {
  const db = env.DB;
  const vectorize = env.VECTORIZE;
  if (!db || !vectorize) throw new Error("Cron ETL requires DB and VECTORIZE bindings");
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  // Legacy rows without an authoritative tenant are intentionally excluded.
  const stale = await db.prepare(
    `SELECT id, source, chunk, tenant FROM documents
     WHERE created_at < ? AND tenant IS NOT NULL AND tenant != '' LIMIT 50`
  ).bind(cutoff).all();
  for (const row of stale.results as any[]) {
    const tenant = requireTenant(row.tenant);
    const [vector] = await embed(env, [row.chunk]);
    await vectorize.upsert([{
      id: row.id,
      values: vector,
      namespace: tenant,
      metadata: { source: row.source, text: String(row.chunk).slice(0, 500), tenant },
    }] as any);
    await emitLineage(env, {
      tenant,
      object_id: row.id,
      transformation: "cron.reembed",
      pipeline_version: "v1",
      model: env.EMBED_MODEL,
      actor: "cron",
    });
  }
}

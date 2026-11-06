import type { Env, Identity } from "../types";
import { infraInventory, putArtifact } from "../infra/stack";

export async function handleInfra(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
  if (path === "/v1/infra/status" && req.method === "GET") {
    const items = infraInventory(env);
    const live = items.filter((i) => i.phase === "live").length;
    const soft = items.filter((i) => i.phase === "soft").length;
    const planned = items.filter((i) => i.phase === "planned").length;
    return json({
      ok: true,
      product: "ASTON OS Infrastructure Map",
      summary: { live, soft, planned, total: items.length },
      items,
      differentiation:
        "Governance layer (passport, decision ledger, measured outcomes) — not commodity agents",
      non_goals: ["air-gapped / DORA offline operations"],
    });
  }

  // Decision ledger write (R2 artifact when JOURNAL bound; else D1 audit soft)
  if (path === "/v1/ledger/decision" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const id = `dec_${crypto.randomUUID().slice(0, 12)}`;
    const record = {
      id,
      tenant: identity.tenant,
      actor: identity.actor,
      action: body.action || "unknown",
      decision: body.decision || "recorded",
      cost_usdc: body.cost_usdc ?? null,
      outcome: body.outcome ?? null,
      policy_ref: body.policy_ref ?? null,
      ts: Date.now(),
    };

    const art = await putArtifact(
      env,
      { tenant: identity.tenant || "default", kind: "decision", id },
      record
    );

    if (env.DB) {
      try {
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS decision_ledger (
            id TEXT PRIMARY KEY,
            tenant TEXT,
            payload TEXT,
            ts INTEGER
          )`
        ).run();
        await env.DB.prepare(
          `INSERT INTO decision_ledger (id, tenant, payload, ts) VALUES (?, ?, ?, ?)`
        )
          .bind(id, identity.tenant || "default", JSON.stringify(record), record.ts)
          .run();
      } catch (e) {
        console.error("[LEDGER_D1]", String(e));
      }
    }

    return json({
      ok: true,
      decision_id: id,
      r2: art,
      d1: !!env.DB,
      note: art.stored
        ? "Stored in R2 catalog path"
        : "Bind JOURNAL (R2) for lakehouse artifacts; D1 used when available",
    });
  }

  if (path === "/v1/ledger/decisions" && req.method === "GET") {
    if (!env.DB) {
      return json({
        ok: true,
        items: [],
        note: "DB not bound — ledger list unavailable",
      });
    }
    try {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS decision_ledger (
          id TEXT PRIMARY KEY,
          tenant TEXT,
          payload TEXT,
          ts INTEGER
        )`
      ).run();
      const rows = await env.DB.prepare(
        `SELECT payload FROM decision_ledger WHERE tenant = ? ORDER BY ts DESC LIMIT 50`
      )
        .bind(identity.tenant || "default")
        .all();
      const items = (rows.results || []).map((r: any) => {
        try {
          return JSON.parse(r.payload);
        } catch {
          return null;
        }
      }).filter(Boolean);
      return json({ ok: true, count: items.length, items });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e).slice(0, 200) }, 500);
    }
  }

  return null;
}

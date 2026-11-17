/**
 * ASTON OS 21.0 route surface — additive, fails soft when optional bindings missing.
 * Does not alter /chat contract.
 */
import type { Env, Identity } from "../types";
import { createObjectType, createObject, createLink, cascadeImpact } from "../ontology";
import { emitLineage, getLineageTree } from "../lineage";
import { maskForAgent } from "../pii";
import { embed, chat, chunk } from "../lib/ai";

export function pillarStatus(env: Env) {
  return {
    ai: !!env.AI,
    session: !!env.SESSION,
    graph: !!env.GRAPH,
    supervisor: !!env.SUPERVISOR,
    agent: !!env.AGENT,
    simulation: !!env.SIMULATION,
    mission: !!env.MISSION,
    safety: !!env.SAFETY,
    d1: !!env.DB,
    vectorize: !!env.VECTORIZE,
    journal: !!env.JOURNAL,
    etl_queue: !!env.ETL_QUEUE,
    missions_queue: !!env.MISSIONS,
    hyperdrive: !!env.HYPERDRIVE,
  };
}

export async function handleV21(
  path: string,
  req: Request,
  env: Env,
  identity: Identity,
  json: (d: unknown, s?: number) => Response
): Promise<Response | null> {
  if (path === "/v1/rag/ingest" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const text = String(body.text || body.content || "").trim();
    const source = String(body.source || "upload").slice(0, 200);
    if (!text) return json({ ok: false, error: "text required" }, 400);
    if (!env.AI) return json({ ok: false, error: "AI required" }, 503);

    const parts = chunk(text);
    const ids: string[] = [];
    for (const part of parts) {
      const id = `doc_${crypto.randomUUID()}`;
      ids.push(id);
      if (env.DB) {
        await env.DB.prepare(
          `INSERT INTO documents (id, source, chunk, created_at) VALUES (?, ?, ?, ?)`
        )
          .bind(id, source, part, Date.now())
          .run()
          .catch(() => {});
      }
      if (env.VECTORIZE) {
        try {
          const [vec] = await embed(env, [part]);
          await env.VECTORIZE.upsert([
            { id, values: vec, metadata: { source, chunk: part.slice(0, 500) } },
          ] as any);
        } catch (e: any) {
          console.warn("[RAG_UPSERT]", e?.message);
        }
      }
      await emitLineage(env, {
        object_id: id,
        transformation: "rag_ingest",
        pipeline_version: "21.0",
        actor: identity.actor,
        metadata: { source },
      });
    }
    return json({ ok: true, chunks: ids.length, ids, vectorize: !!env.VECTORIZE, d1: !!env.DB });
  }

  if (path === "/v1/rag/query" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const q = String(body.query || body.q || "").trim();
    if (!q) return json({ ok: false, error: "query required" }, 400);
    if (!env.VECTORIZE) {
      return json({
        ok: true,
        matches: [],
        note: "VECTORIZE not bound — configure index knowledge-base to enable semantic search",
      });
    }
    try {
      const [qvec] = await embed(env, [q]);
      const m = await env.VECTORIZE.query(qvec, { topK: body.topK ?? 5, returnMetadata: "all" } as any);
      return json({ ok: true, matches: m.matches ?? [] });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e).slice(0, 200) }, 502);
    }
  }

  if (path === "/v1/ontology/types" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    if (!env.DB) return json({ ok: false, error: "DB binding required for ontology types", pillar: "ontology" }, 503);
    try {
      const id = await createObjectType(env, { name: body.name || "Entity", schema: body.schema || {} });
      return json({ ok: true, id });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }

  if (path === "/v1/ontology/objects" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    if (!env.DB || !env.GRAPH) return json({ ok: false, error: "DB + GRAPH required", pillar: "ontology" }, 503);
    try {
      const id = await createObject(env, identity, {
        type_id: body.type_id,
        properties: body.properties || {},
      });
      return json({ ok: true, id });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }

  if (path === "/v1/ontology/links" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    if (!env.DB || !env.GRAPH) return json({ ok: false, error: "DB + GRAPH required", pillar: "ontology" }, 503);
    try {
      const id = await createLink(env, identity, {
        from_id: body.from_id,
        to_id: body.to_id,
        type: body.type || "related",
        properties: body.properties,
      });
      return json({ ok: true, id });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }

  if (path === "/v1/ontology/impact" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const rows = await cascadeImpact(env, identity.tenant, body.root_id || body.id, body.at ?? Date.now());
    return json({ ok: true, impact: rows });
  }

  if (path === "/v1/graph/neighbors" && req.method === "GET") {
    if (!env.GRAPH) return json({ ok: false, error: "GRAPH DO not bound" }, 503);
    const u = new URL(req.url);
    const stub = env.GRAPH.get(env.GRAPH.idFromName(identity.tenant));
    const id = u.searchParams.get("id") || "";
    const res = await stub.fetch(`https://do/neighbors?id=${encodeURIComponent(id)}`);
    return json({ ok: true, ...(await res.json<any>()) });
  }

  if (path === "/v1/graph/path" && req.method === "GET") {
    if (!env.GRAPH) return json({ ok: false, error: "GRAPH DO not bound" }, 503);
    const u = new URL(req.url);
    const stub = env.GRAPH.get(env.GRAPH.idFromName(identity.tenant));
    const from = u.searchParams.get("from") || "";
    const to = u.searchParams.get("to") || "";
    const res = await stub.fetch(
      `https://do/path?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    );
    return json({ ok: true, ...(await res.json<any>()) });
  }

  if (path === "/v1/lineage" && req.method === "GET") {
    const u = new URL(req.url);
    const objectId = u.searchParams.get("object_id") || "";
    if (!objectId) return json({ ok: false, error: "object_id required" }, 400);
    const events = await getLineageTree(env, objectId);
    return json({ ok: true, events, d1: !!env.DB });
  }

  if (path === "/v1/swarm/plan" && req.method === "POST") {
    if (!env.SUPERVISOR) return json({ ok: false, error: "SUPERVISOR DO not bound" }, 503);
    const body = await req.json<any>().catch(() => ({}));
    const objective = String(body.objective || body.goal || "").trim();
    if (!objective) return json({ ok: false, error: "objective required" }, 400);
    const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(identity.tenant));
    const res = await stub.fetch("https://do/plan", {
      method: "POST",
      body: JSON.stringify({ objective, identity }),
    });
    const data = await res.json<any>();
    return json({ ok: res.ok, ...data }, res.status);
  }

  // Simulation twin: /init | /apply | /evaluate | /commit
  if (path.startsWith("/v1/simulation") && req.method === "POST") {
    if (!env.SIMULATION) return json({ ok: false, error: "SIMULATION DO not bound" }, 503);
    const body = await req.json<any>().catch(() => ({}));
    const action = path === "/v1/simulation" ? body.action || "evaluate" : path.replace("/v1/simulation/", "");
    const doPath =
      action === "init"
        ? "/init"
        : action === "apply"
          ? "/apply"
          : action === "commit"
            ? "/commit"
            : "/evaluate";
    const stub = env.SIMULATION.get(env.SIMULATION.idFromName(identity.tenant));
    const payload =
      doPath === "/commit"
        ? { identity }
        : doPath === "/evaluate"
          ? { question: body.question || body.scenario || body.message || "Evaluate risks", identity }
          : { ...body, identity };
    const res = await stub.fetch(`https://do${doPath}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = await res.json<any>().catch(() => ({}));
    return json({ ok: res.ok, ...data }, res.ok ? 200 : res.status);
  }

  // Mission brain: POST /run
  if (path === "/v1/mission" && req.method === "POST") {
    if (!env.MISSION) return json({ ok: false, error: "MISSION DO not bound" }, 503);
    const body = await req.json<any>().catch(() => ({}));
    const mission = {
      id: body.id || `m_${crypto.randomUUID()}`,
      origin: body.origin || "https://example.com",
      pool_id: body.pool_id || "",
      error_code: Number(body.error_code) || 0,
      severity: body.severity || "low",
      created_at: Date.now(),
      created_by: identity.actor,
    };
    const stub = env.MISSION.get(env.MISSION.idFromName(mission.id));
    const res = await stub.fetch("https://do/run", {
      method: "POST",
      body: JSON.stringify(mission),
    });
    const data = await res.json<any>().catch(() => ({}));
    return json({ ok: res.ok, ...data }, res.ok ? 200 : res.status);
  }

  if (path === "/v1/safety/evaluate" && req.method === "POST") {
    if (!env.SAFETY) return json({ ok: false, error: "SAFETY DO not bound" }, 503);
    const body = await req.json<any>().catch(() => ({}));
    const stub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
    const res = await stub.fetch("https://do/evaluate", {
      method: "POST",
      body: JSON.stringify({ action: body.action || body, identity }),
    });
    return json({ ok: true, ...(await res.json<any>()) });
  }

  if (path === "/v1/pii/mask" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const text = String(body.text || "");
    const secret = env.PII_HMAC_SECRET || "aston-edge-default-pii";
    const { masked } = await maskForAgent(text, body.clearance || identity.clearance, secret);
    return json({ ok: true, masked });
  }

  if (path === "/v1/audit" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    if (env.DB) {
      await env.DB.prepare(`INSERT INTO audit_log (ts, action, actor, detail) VALUES (?, ?, ?, ?)`)
        .bind(Date.now(), body.action || "event", identity.actor, JSON.stringify(body.detail || body))
        .run()
        .catch(() => {});
    }
    if (env.JOURNAL) {
      await env.JOURNAL.put(
        `audit/${Date.now()}-${crypto.randomUUID()}.json`,
        JSON.stringify({ ts: Date.now(), actor: identity.actor, body }),
        { httpMetadata: { contentType: "application/json" } }
      ).catch(() => {});
    }
    return json({ ok: true, persisted: { d1: !!env.DB, journal: !!env.JOURNAL } });
  }

  if (path === "/v1/etl/enqueue" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    if (!env.ETL_QUEUE) {
      return json({ ok: true, queued: false, note: "ETL_QUEUE not bound — dry-run", payload: body });
    }
    await env.ETL_QUEUE.send({ ...body, actor: identity.actor, ts: Date.now() });
    return json({ ok: true, queued: true });
  }

  if (path === "/v1/decide" && req.method === "POST") {
    const body = await req.json<any>().catch(() => ({}));
    const message = String(body.message || body.objective || "").trim();
    if (!message) return json({ ok: false, error: "message required" }, 400);
    if (!env.SAFETY) return json({ ok: false, error: "decision_safety_binding_unavailable" }, 503);
    try {
      const safetyStub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
      const safetyResponse = await safetyStub.fetch("https://do/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: { tool: "decision_inference", args: { message_length: message.length }, context: { objective: "ASTON decision request" } },
          identity,
        }),
      });
      const safetyResult = await safetyResponse.json<any>().catch(() => ({}));
      if (!safetyResponse.ok || safetyResult.status !== "allowed") {
        return json({ ok: false, error: "decision_blocked_by_safety_interlock", policy: safetyResult.policy }, safetyResponse.ok ? 403 : 503);
      }
    } catch {
      return json({ ok: false, error: "decision_safety_unavailable" }, 503);
    }
    let context = "";
    if (env.VECTORIZE && env.AI) {
      try {
        const [qvec] = await embed(env, [message]);
        const m = await env.VECTORIZE.query(qvec, { topK: 3, returnMetadata: "all" } as any);
        context = (m.matches ?? [])
          .map((x: any) => x.metadata?.chunk)
          .filter(Boolean)
          .join("\n---\n");
      } catch {
        /* ignore */
      }
    }
    const out = await chat(env, [
      {
        role: "system",
        content:
          "ASTON OS decision engine. Sé concreto. Si hay contexto RAG, úsalo; no inventes hechos.",
      },
      ...(context
        ? [{ role: "user" as const, content: `Contexto:\n${context}\n\nPregunta: ${message}` }]
        : [{ role: "user" as const, content: message }]),
    ]);
    if (env.DB) {
      await env.DB.prepare(`INSERT INTO audit_log (ts, action, actor, detail) VALUES (?, ?, ?, ?)`)
        .bind(Date.now(), "decide", identity.actor, JSON.stringify({ message: message.slice(0, 200) }))
        .run()
        .catch(() => {});
    }
    return json({ ok: true, answer: out.response, model: out.model, rag: !!context, version: "21.0-edge" });
  }

  return null;
}

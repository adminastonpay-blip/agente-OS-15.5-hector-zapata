/**
 * Agente OS 15.5 — perfil MINIMAL: deploy sin D1/R2/Vectorize/Queues/Hyperdrive.
 */
import type { Env, Mission } from "./types";
import { authenticate } from "./auth";
import { maskForAgent, restoreFromVault } from "./pii";
import { getLineageTree } from "./lineage";
import { createObjectType, createObject, createLink, findObjectsByProperty, cascadeImpact } from "./ontology";
import { handleETLQueue, handleCron } from "./etl";
import { embed, chat } from "./lib/ai";
import { consumeMissions } from "./queue/consumer";
import { SessionMemory } from "./do/session";
import { GraphResolver } from "./do/graph-do";
import { Supervisor } from "./do/supervisor";
import { AgentNode } from "./do/agent-node";
import { SimulationTwin } from "./do/simulation";
import { MissionBrain } from "./do/mission-brain";
import { SafetyInterlock } from "./do/safety-interlock";
import { RecoveryWorkflow } from "./workflows/recovery";
import { CertifiedExtractionWorkflow } from "./workflows/certified-extraction";
import { handleMcpRequest } from "./mcp/governance";

export {
  SessionMemory, GraphResolver, Supervisor, AgentNode, SimulationTwin,
  MissionBrain, SafetyInterlock, RecoveryWorkflow, CertifiedExtractionWorkflow,
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,Cf-Access-Jwt-Assertion,X-Sensor-Key",
};
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json", ...CORS } });

function need(env: Env, key: keyof Env, label: string): Response | null {
  if (!(env as any)[key]) {
    return json({
      error: "binding_unavailable",
      binding: label,
      message: `Perfil minimal: falta binding ${label}. Creá el recurso y reactiválo en wrangler.toml.`,
      profile: env.DEPLOY_PROFILE ?? "unknown",
    }, 503);
  }
  return null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(req.url);

    if (u.pathname === "/health") {
      return json({
        ok: true,
        ts: Date.now(),
        profile: env.DEPLOY_PROFILE ?? "full",
        bindings: {
          AI: !!env.AI, DB: !!env.DB, JOURNAL: !!env.JOURNAL,
          VECTORIZE: !!env.VECTORIZE, HYPERDRIVE: !!env.HYPERDRIVE,
          ETL_QUEUE: !!env.ETL_QUEUE, SESSION: !!env.SESSION, SAFETY: !!env.SAFETY,
        },
      });
    }

    if (u.pathname === "/mcp" || u.pathname.startsWith("/mcp/"))
      return handleMcpRequest(req, env);

    let identity = await authenticate(req, env);
    if (!identity && env.DEPLOY_PROFILE === "minimal" && !env.API_KEY) {
      identity = {
        actor: "bootstrap@minimal", method: "apikey", tenant: "default",
        roles: ["admin", "executor"], clearance: "confidential",
      };
    }
    if (!identity) return json({ error: "unauthorized" }, 401);

    if (u.pathname === "/chat" && req.method === "POST") {
      const { session_id, message } = await req.json<any>();
      if (!session_id || !message) return json({ error: "session_id y message requeridos" }, 400);
      let context = "";
      if (env.VECTORIZE) {
        try {
          const [qvec] = await embed(env, [message]);
          const matches = await env.VECTORIZE.query(qvec, { topK: 5, returnMetadata: "all" } as any);
          context = (matches.matches ?? []).map((m: any) => `[${m.metadata?.source}] ${m.metadata?.chunk}`).join("\n---\n");
        } catch { /* RAG opcional */ }
      }
      const stub = env.SESSION.get(env.SESSION.idFromName(session_id));
      const mem = await (await stub.fetch("https://do/get")).json<{ history: any[] }>();
      const messages = [
        { role: "system", content: "Agente semántico empresarial. Responde en español." },
        ...mem.history.slice(-10).map((h: any) => ({ role: h.role, content: h.content })),
        { role: "user", content: context ? `Contexto:\n${context}\n\nPregunta: ${message}` : message },
      ];
      const out = await chat(env, messages);
      let answer = out.response;
      if (env.PII_HMAC_SECRET) {
        const { masked, vault } = await maskForAgent(out.response, identity.clearance, env.PII_HMAC_SECRET);
        answer = restoreFromVault(masked, vault);
      }
      await stub.fetch("https://do/append", { method: "POST", body: JSON.stringify({ role: "user", content: message }) });
      await stub.fetch("https://do/append", { method: "POST", body: JSON.stringify({ role: "assistant", content: answer }) });
      return json({ answer, rag: !!env.VECTORIZE, profile: env.DEPLOY_PROFILE });
    }

    if (u.pathname === "/etl/ingest" && req.method === "POST") {
      const blocked = need(env, "ETL_QUEUE", "ETL_QUEUE");
      if (blocked) return blocked;
      const b = await req.json<any>();
      let text = b.text ?? "";
      if (env.PII_HMAC_SECRET) {
        const { masked } = await maskForAgent(text, identity.clearance, env.PII_HMAC_SECRET);
        text = masked;
      }
      await env.ETL_QUEUE!.send({ kind: "ingest", source: b.source, text, tenant: identity.tenant, actor: identity.actor });
      return json({ enqueued: true });
    }

    if (u.pathname.startsWith("/ontology") || u.pathname.startsWith("/lineage") || u.pathname === "/audit") {
      const blocked = need(env, "DB", "DB");
      if (blocked) return blocked;
    }

    if (u.pathname === "/ontology/types" && req.method === "POST")
      return json({ id: await createObjectType(env, await req.json<any>()) });
    if (u.pathname === "/ontology/objects" && req.method === "POST") {
      const b = await req.json<any>();
      return json({ id: await createObject(env, identity, { type_id: b.type_id, properties: b.properties }) });
    }
    if (u.pathname === "/ontology/links" && req.method === "POST")
      return json({ id: await createLink(env, identity, await req.json<any>()) });
    if (u.pathname === "/ontology/objects" && req.method === "GET")
      return json({ rows: await findObjectsByProperty(env, identity, u.searchParams.get("type")!, u.searchParams.get("key")!, u.searchParams.get("value")) });
    if (u.pathname.startsWith("/ontology/neighbors/")) {
      const stub = env.GRAPH.get(env.GRAPH.idFromName(identity.tenant));
      return json(await (await stub.fetch(`https://do/neighbors?id=${u.pathname.split("/").pop()}`)).json());
    }
    if (u.pathname === "/ontology/path") {
      const stub = env.GRAPH.get(env.GRAPH.idFromName(identity.tenant));
      return json(await (await stub.fetch(`https://do/path?from=${u.searchParams.get("from")}&to=${u.searchParams.get("to")}`)).json());
    }
    if (u.pathname === "/ontology/impact" && req.method === "POST") {
      const { root_id, at_ts } = await req.json<any>();
      return json({ impact: await cascadeImpact(env, identity.tenant, root_id, at_ts ?? Date.now()) });
    }
    if (u.pathname.startsWith("/lineage/"))
      return json({ tree: await getLineageTree(env, u.pathname.split("/").pop()!) });

    if (u.pathname === "/swarm/run" && req.method === "POST") {
      const b = await req.json<any>();
      const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(identity.tenant));
      return json(await (await stub.fetch("https://do/plan", {
        method: "POST", body: JSON.stringify({ objective: b.objective, identity }),
      })).json());
    }

    if (u.pathname === "/safety/evaluate" && req.method === "POST") {
      const body = await req.json<any>();
      const stub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
      return json(await (await stub.fetch("https://do/evaluate", {
        method: "POST", body: JSON.stringify({ action: body.action, identity }),
      })).json());
    }
    if (u.pathname === "/safety/pending" && req.method === "GET") {
      const stub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
      return json(await (await stub.fetch("https://do/pending")).json());
    }
    if (u.pathname === "/safety/decide" && req.method === "POST") {
      const body = await req.json<any>();
      const stub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
      return json(await (await stub.fetch("https://do/decide", {
        method: "POST", body: JSON.stringify({ ...body, operator: identity.actor }),
      })).json());
    }
    if (u.pathname === "/safety/log" && req.method === "GET") {
      const stub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
      return json(await (await stub.fetch("https://do/log")).json());
    }

    if (u.pathname === "/extraction/certify" && req.method === "POST") {
      const body = await req.json<any>();
      if (!body.documentId || !body.schema) return json({ error: "documentId and schema required" }, 400);
      const wf = await env.CERTIFIED_EXTRACTION_WF.create({
        params: {
          documentId: body.documentId, tenant: identity.tenant, actor: identity.actor,
          rawText: body.text ?? body.rawText, images: body.images, schema: body.schema,
          schema_version: body.schema_version ?? "v1", thresholds: body.thresholds,
        },
      });
      return json({ workflow_id: wf.id, status: "started" });
    }

    if (u.pathname === "/ingest-failure" && req.method === "POST") {
      const body = await req.json<any>();
      const mission: Mission = {
        id: `mis_${crypto.randomUUID()}`, origin: body.origin, pool_id: body.pool_id,
        error_code: body.error_code, severity: body.severity ?? "high",
        created_at: Date.now(), created_by: identity.actor,
      };
      if (env.MISSIONS) await env.MISSIONS.send(mission);
      const wf = await env.RECOVERY_WF.create({
        params: {
          origin: mission.origin, pool_id: mission.pool_id, error_code: mission.error_code,
          severity: mission.severity, requestedBy: identity.actor,
        },
      });
      return json({ mission_id: mission.id, workflow_id: wf.id, queue: !!env.MISSIONS });
    }

    if (u.pathname === "/audit" && req.method === "GET") {
      const rows = await env.DB!.prepare("SELECT ts, action, actor, detail FROM audit_log ORDER BY id DESC LIMIT 50").all();
      return json({ entries: rows.results });
    }

    return json({ error: "not found" }, 404);
  },

  async queue(batch: MessageBatch<any>, env: Env) {
    if (batch.queue === "etl-pipeline" && env.DB) return handleETLQueue(batch, env);
    if (batch.queue === "recovery.missions") return consumeMissions(batch as MessageBatch<Mission>, env);
  },

  async scheduled(_evt: ScheduledEvent, env: Env) {
    if (env.DB && env.VECTORIZE) return handleCron(env);
  },
} satisfies ExportedHandler<Env>;

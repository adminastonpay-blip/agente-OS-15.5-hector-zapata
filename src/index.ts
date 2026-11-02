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

export { SessionMemory, GraphResolver, Supervisor, AgentNode, SimulationTwin, MissionBrain, SafetyInterlock, RecoveryWorkflow, CertifiedExtractionWorkflow };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,Cf-Access-Jwt-Assertion,X-Sensor-Key",
};
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { "Content-Type": "application/json", ...CORS },
});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const u = new URL(req.url);
    if (u.pathname === "/health") return json({ ok: true, ts: Date.now() });

    // ===== MCP Governance Server (Océano Azul) =====
    if (u.pathname === "/mcp" || u.pathname.startsWith("/mcp/")) {
      return handleMcpRequest(req, env);
    }

    const identity = await authenticate(req, env);
    if (!identity) return json({ error: "unauthorized" }, 401);

    // ===== ETL =====
    if (u.pathname === "/etl/ingest" && req.method === "POST") {
      const b = await req.json<any>();
      const { masked, vault } = await maskForAgent(b.text ?? "", identity.clearance, env.PII_HMAC_SECRET!);
      await env.ETL_QUEUE.send({
        kind: "ingest", source: b.source, text: masked,
        tenant: identity.tenant, actor: identity.actor,
      });
      return json({ enqueued: true, pii_masked: vault.size });
    }

    // ===== RAG / Chat =====
    if (u.pathname === "/chat" && req.method === "POST") {
      const { session_id, message } = await req.json<any>();
      if (!session_id || !message) return json({ error: "session_id y message requeridos" }, 400);
      const [qvec] = await embed(env, [message]);
      const matches = await env.VECTORIZE.query(qvec, { topK: 5, returnMetadata: "all" } as any);
      const context = (matches.matches ?? []).map((m: any) =>
        `[${m.metadata?.source}] ${m.metadata?.chunk}`).join("\n---\n");

      const stub = env.SESSION.get(env.SESSION.idFromName(session_id));
      const mem = await (await stub.fetch("https://do/get")).json<{ history: any[] }>();

      const messages = [
        { role: "system", content: "Agente semántico empresarial. Responde en español, cita fuentes." },
        ...mem.history.slice(-10).map((h: any) => ({ role: h.role, content: h.content })),
        { role: "user", content: context ? `Contexto:\n${context}\n\nPregunta: ${message}` : message },
      ];
      const out = await chat(env, messages);
      const { masked, vault } = await maskForAgent(out.response, identity.clearance, env.PII_HMAC_SECRET!);
      const answer = restoreFromVault(masked, vault);

      await stub.fetch("https://do/append", { method: "POST",
        body: JSON.stringify({ role: "user", content: message }) });
      await stub.fetch("https://do/append", { method: "POST",
        body: JSON.stringify({ role: "assistant", content: answer }) });

      return json({ answer, sources: (matches.matches ?? []).map((m: any) => m.metadata?.source) });
    }

    // ===== Ontología =====
    if (u.pathname === "/ontology/types" && req.method === "POST")
      return json({ id: await createObjectType(env, await req.json<any>()) });
    if (u.pathname === "/ontology/objects" && req.method === "POST") {
      const b = await req.json<any>();
      const { masked } = await maskForAgent(JSON.stringify(b.properties), identity.clearance, env.PII_HMAC_SECRET!);
      return json({ id: await createObject(env, identity,
        { type_id: b.type_id, properties: JSON.parse(masked) }) });
    }
    if (u.pathname === "/ontology/links" && req.method === "POST")
      return json({ id: await createLink(env, identity, await req.json<any>()) });
    if (u.pathname === "/ontology/objects" && req.method === "GET")
      return json({ rows: await findObjectsByProperty(env, identity,
        u.searchParams.get("type")!, u.searchParams.get("key")!, u.searchParams.get("value")) });
    if (u.pathname.startsWith("/ontology/neighbors/")) {
      const stub = env.GRAPH.get(env.GRAPH.idFromName(identity.tenant));
      return json(await (await stub.fetch(`https://do/neighbors?id=${u.pathname.split("/").pop()}`)).json());
    }
    if (u.pathname === "/ontology/path") {
      const stub = env.GRAPH.get(env.GRAPH.idFromName(identity.tenant));
      return json(await (await stub.fetch(
        `https://do/path?from=${u.searchParams.get("from")}&to=${u.searchParams.get("to")}`)).json());
    }
    if (u.pathname === "/ontology/impact" && req.method === "POST") {
      const { root_id, at_ts } = await req.json<any>();
      return json({ impact: await cascadeImpact(env, identity.tenant, root_id, at_ts ?? Date.now()) });
    }

    // ===== Linaje =====
    if (u.pathname.startsWith("/lineage/"))
      return json({ tree: await getLineageTree(env, u.pathname.split("/").pop()!) });

    // ===== Swarm =====
    if (u.pathname === "/swarm/run" && req.method === "POST") {
      const b = await req.json<any>();
      const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(identity.tenant));
      return json(await (await stub.fetch("https://do/plan", {
        method: "POST", body: JSON.stringify({ objective: b.objective, identity }),
      })).json());
    }

    // ===== Simulación / Decision Twin =====
    if (u.pathname === "/simulation" && req.method === "POST") {
      const b = await req.json<any>();
      const simId = `sim_${crypto.randomUUID()}`;
      const rows = await env.DB.prepare(
        "SELECT id, type_id, properties FROM objects WHERE tenant = ? AND valid_to IS NULL LIMIT 200"
      ).bind(identity.tenant).all();
      const stub = env.SIMULATION.get(env.SIMULATION.idFromName(simId));
      await stub.fetch("https://do/init", { method: "POST",
        body: JSON.stringify({ objects: rows.results }) });
      await env.DB.prepare(
        "INSERT INTO simulations (id, tenant, scenario, status, created_at, created_by) VALUES (?, ?, ?, 'active', ?, ?)"
      ).bind(simId, identity.tenant, JSON.stringify(b.scenario ?? {}), Date.now(), identity.actor).run();
      return json({ simId });
    }
    if (u.pathname.match(/^\/simulation\/[^/]+\/apply$/)) {
      const simId = u.pathname.split("/")[2];
      const stub = env.SIMULATION.get(env.SIMULATION.idFromName(simId));
      return json(await (await stub.fetch("https://do/apply", {
        method: "POST", body: await req.text(),
      })).json());
    }
    if (u.pathname.match(/^\/simulation\/[^/]+\/evaluate$/)) {
      const simId = u.pathname.split("/")[2];
      const stub = env.SIMULATION.get(env.SIMULATION.idFromName(simId));
      return json(await (await stub.fetch("https://do/evaluate", {
        method: "POST", body: await req.text(),
      })).json());
    }
    if (u.pathname.match(/^\/simulation\/[^/]+\/commit$/)) {
      const simId = u.pathname.split("/")[2];
      const stub = env.SIMULATION.get(env.SIMULATION.idFromName(simId));
      return json(await (await stub.fetch("https://do/commit", {
        method: "POST", body: JSON.stringify({ identity }),
      })).json());
    }

    // ===== Recovery / Logistics Mesh =====
    if (u.pathname === "/ingest-failure" && req.method === "POST") {
      const body = await req.json<any>();
      const mission: Mission = {
        id: `mis_${crypto.randomUUID()}`,
        origin: body.origin,
        pool_id: body.pool_id,
        error_code: body.error_code,
        severity: body.severity ?? "high",
        created_at: Date.now(),
        created_by: identity.actor,
      };
      await env.MISSIONS.send(mission);
      const wf = await env.RECOVERY_WF.create({
        params: {
          origin: mission.origin, pool_id: mission.pool_id,
          error_code: mission.error_code, severity: mission.severity,
          requestedBy: identity.actor,
        },
      });
      return json({ mission_id: mission.id, workflow_id: wf.id, enqueued: true });
    }
    if (u.pathname.startsWith("/mission/") && req.method === "GET") {
      const id = u.pathname.split("/").pop()!;
      const brain = env.MISSION.get(env.MISSION.idFromName(`mission:${id}`));
      return json(await (await brain.fetch("https://do/journal")).json());
    }
    if (u.pathname.match(/^\/workflow\/[^/]+\/approve$/) && req.method === "POST") {
      const wfId = u.pathname.split("/")[2];
      const { approved } = await req.json<any>();
      const inst = await env.RECOVERY_WF.get(wfId);
      if (!inst) return json({ error: "workflow not found" }, 404);
      await inst.sendEvent({ type: "recovery.approved", payload: { approved, operator: identity.actor } });
      return json({ sent: true });
    }

    // ===== Certified Extraction Engine (CEE) =====
    if (u.pathname === "/extraction/certify" && req.method === "POST") {
      const body = await req.json<any>();
      if (!body.documentId || !body.schema) {
        return json({ error: "documentId and schema required" }, 400);
      }
      const wf = await env.CERTIFIED_EXTRACTION_WF.create({
        params: {
          documentId: body.documentId,
          tenant: identity.tenant,
          actor: identity.actor,
          rawText: body.text ?? body.rawText,
          images: body.images,
          schema: body.schema,
          schema_version: body.schema_version ?? "v1",
          thresholds: body.thresholds,
        },
      });
      return json({ workflow_id: wf.id, status: "started" });
    }
    if (u.pathname.match(/^\/extraction\/workflow\/[^/]+\/review$/) && req.method === "POST") {
      const wfId = u.pathname.split("/")[3];
      const { corrections, reviewer } = await req.json<any>();
      const inst = await env.CERTIFIED_EXTRACTION_WF.get(wfId);
      if (!inst) return json({ error: "workflow not found" }, 404);
      await inst.sendEvent({
        type: "extraction.reviewed",
        payload: { corrections: corrections ?? {}, reviewer: reviewer ?? identity.actor },
      });
      return json({ sent: true });
    }
    if (u.pathname === "/extraction/certificates" && req.method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT id, object_id, document_id, certified_count, total_count, actor, created_at
         FROM extraction_certificates WHERE tenant = ? ORDER BY created_at DESC LIMIT 50`
      ).bind(identity.tenant).all();
      return json({ certificates: rows.results });
    }

    // ===== Safety Interlock =====
    if (u.pathname === "/safety/evaluate" && req.method === "POST") {
      const body = await req.json<any>();
      const stub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
      return json(await (await stub.fetch("https://do/evaluate", {
        method: "POST",
        body: JSON.stringify({ action: body.action, identity }),
      })).json());
    }
    if (u.pathname === "/safety/pending" && req.method === "GET") {
      const stub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
      return json(await (await stub.fetch("https://do/pending")).json());
    }
    if (u.pathname === "/safety/decide" && req.method === "POST") {
      const body = extawait req.json<any>();
      const stub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
      return json(await (await stub.fetch("https://do/decide", {
        method: "POST",
        body: JSON.stringify({ ...body, operator: identity.actor }),
      })).json());
    }
    if (u.pathname === "/safety/sandbox/exec" && req.method === "POST") {
      const body = await req.json<any>();
      const stub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
      return json(await (await stub.fetch("https://do/sandbox/exec", {
        method: "POST",
        body: JSON.stringify({ ...body, identity }),
      })).json());
    }
    if (u.pathname === "/safety/log" && req.method === "GET") {
      const stub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
      return json(await (await stub.fetch("https://do/log")).json());
    }

    // ===== Audit =====
    if (u.pathname === "/audit" && req.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT ts, action, actor, detail FROM audit_log ORDER BY id DESC LIMIT 50"
      ).all();
      return json({ entries: rows.results });
    }

    return json({ error: "not found" }, 404);
  },

  async queue(batch: MessageBatch<any>, env: Env) {
    if (batch.queue === "etl-pipeline") return handleETLQueue(batch, env);
    if (batch.queue === "recovery.missions") return consumeMissions(batch as MessageBatch<Mission>, env);
  },

  async scheduled(_evt: ScheduledEvent, env: Env) {
    return handleCron(env);
  },
} satisfies ExportedHandler<Env>;

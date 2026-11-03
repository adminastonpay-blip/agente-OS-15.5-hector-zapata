/**
 * Aston OS 15.5 — deploy-safe entrypoint
 * Sin Workflows / Queues / D1 / MCP-SDK en el grafo de imports crítico.
 */
import type { Env } from "./types";
import { authenticate } from "./auth";
import { chat } from "./lib/ai";
import { SessionMemory } from "./do/session";
import { GraphResolver } from "./do/graph-do";
import { Supervisor } from "./do/supervisor";
import { AgentNode } from "./do/agent-node";
import { SimulationTwin } from "./do/simulation";
import { MissionBrain } from "./do/mission-brain";
import { SafetyInterlock } from "./do/safety-interlock";
import { handleMcpRequest } from "./mcp/governance";

export {
  SessionMemory,
  GraphResolver,
  Supervisor,
  AgentNode,
  SimulationTwin,
  MissionBrain,
  SafetyInterlock,
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,Cf-Access-Jwt-Assertion,X-Sensor-Key",
};

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { "Content-Type": "application/json", ...CORS },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const u = new URL(req.url);

    if (u.pathname === "/health") {
      return json({
        ok: true,
        ts: Date.now(),
        profile: env.DEPLOY_PROFILE ?? "minimal",
        version: "15.5.0",
        bindings: {
          AI: !!env.AI,
          SESSION: !!env.SESSION,
          SAFETY: !!env.SAFETY,
          SUPERVISOR: !!env.SUPERVISOR,
          DB: !!env.DB,
          VECTORIZE: !!env.VECTORIZE,
        },
      });
    }

    if (u.pathname === "/mcp" || u.pathname.startsWith("/mcp/")) {
      return handleMcpRequest(req, env);
    }

    let identity = await authenticate(req, env);
    if (!identity && env.DEPLOY_PROFILE === "minimal") {
      identity = {
        actor: "bootstrap@minimal",
        method: "apikey",
        tenant: "default",
        roles: ["admin", "executor"],
        clearance: "confidential",
      };
    }
    if (!identity) return json({ error: "unauthorized" }, 401);

    if (u.pathname === "/chat" && req.method === "POST") {
      const body = await req.json<any>();
      const session_id = body.session_id ?? "default";
      const message = body.message;
      if (!message) return json({ error: "message requerido" }, 400);

      const stub = env.SESSION.get(env.SESSION.idFromName(session_id));
      let history: any[] = [];
      try {
        const mem = await (await stub.fetch("https://do/get")).json<{ history: any[] }>();
        history = mem.history ?? [];
      } catch {
        history = [];
      }

      const messages = [
        { role: "system", content: "Agente Aston OS. Responde en español, breve y claro." },
        ...history.slice(-8).map((h: any) => ({ role: h.role, content: h.content })),
        { role: "user", content: message },
      ];

      const out = await chat(env, messages);
      const answer = out.response ?? String(out);

      try {
        await stub.fetch("https://do/append", {
          method: "POST",
          body: JSON.stringify({ role: "user", content: message }),
        });
        await stub.fetch("https://do/append", {
          method: "POST",
          body: JSON.stringify({ role: "assistant", content: answer }),
        });
      } catch {
        /* session opcional */
      }

      return json({ answer, profile: env.DEPLOY_PROFILE });
    }

    if (u.pathname === "/safety/evaluate" && req.method === "POST") {
      const body = await req.json<any>();
      const stub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
      return json(
        await (
          await stub.fetch("https://do/evaluate", {
            method: "POST",
            body: JSON.stringify({ action: body.action, identity }),
          })
        ).json()
      );
    }
    if (u.pathname === "/safety/pending" && req.method === "GET") {
      const stub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
      return json(await (await stub.fetch("https://do/pending")).json());
    }
    if (u.pathname === "/safety/decide" && req.method === "POST") {
      const body = await req.json<any>();
      const stub = env.SAFETY.get(env.SAFETY.idFromName(identity.tenant));
      return json(
        await (
          await stub.fetch("https://do/decide", {
            method: "POST",
            body: JSON.stringify({ ...body, operator: identity.actor }),
          })
        ).json()
      );
    }

    if (u.pathname === "/swarm/run" && req.method === "POST") {
      const b = await req.json<any>();
      const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(identity.tenant));
      return json(
        await (
          await stub.fetch("https://do/plan", {
            method: "POST",
            body: JSON.stringify({ objective: b.objective, identity }),
          })
        ).json()
      );
    }

    return json({
      error: "not found",
      hint: "Rutas activas: /health /chat /safety/* /swarm/run /mcp",
    }, 404);
  },
} satisfies ExportedHandler<Env>;

import type { Env } from "./types";
import { chat } from "./lib/ai";
import { SessionMemory } from "./do/session";

export { SessionMemory };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
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
        version: "15.5.0-minimal",
        profile: env.DEPLOY_PROFILE ?? "minimal",
      });
    }

    if (u.pathname === "/chat" && req.method === "POST") {
      const body = await req.json<any>().catch(() => ({}));
      const message = body.message;
      if (!message) return json({ error: "message requerido" }, 400);
      const session_id = body.session_id ?? "default";

      const stub = env.SESSION.get(env.SESSION.idFromName(session_id));
      let history: any[] = [];
      try {
        const mem = await (await stub.fetch("https://do/get")).json<{ history: any[] }>();
        history = mem.history ?? [];
      } catch {
        history = [];
      }

      const messages = [
        { role: "system", content: "Agente Aston OS. Responde en español, breve." },
        ...history.slice(-8).map((h: any) => ({ role: h.role, content: h.content })),
        { role: "user", content: message },
      ];

      const out = await chat(env, messages);
      const answer = out.response ?? "";

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
        /* ignore */
      }

      return json({ answer });
    }

    return json({ error: "not found", routes: ["/health", "/chat"] }, 404);
  },
} satisfies ExportedHandler<Env>;

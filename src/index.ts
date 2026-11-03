import type { Env } from "./types";
import { chat } from "./lib/ai";
import { SessionMemory } from "./do/session";

export { SessionMemory };

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,Accept",
};

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });

async function handleChat(req: Request, env: Env): Promise<Response> {
  try {
    const body = await req.json<any>().catch(() => ({}));
    const message =
      typeof body.message === "string"
        ? body.message.trim()
        : typeof body.prompt === "string"
          ? body.prompt.trim()
          : "";
    if (!message) return json({ ok: false, error: "message requerido" }, 400);

    const session_id =
      typeof body.session_id === "string" && body.session_id
        ? body.session_id.slice(0, 80)
        : "default";

    const stub = env.SESSION.get(env.SESSION.idFromName(session_id));
    let history: any[] = [];
    try {
      const mem = await (await stub.fetch("https://do/get")).json<{ history: any[] }>();
      history = mem.history ?? [];
    } catch {
      history = [];
    }

    const messages = [
      {
        role: "system",
        content:
          "Eres ASTON OS, asistente de Lane & Aston. Responde en español, claro y breve. No inventes precios ni stock.",
      },
      ...history.slice(-8).map((h: any) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];

    const out = await chat(env, messages);
    const answer = out.response || "";

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
      /* ignore DO write errors */
    }

    // Compatible with ASTON Shopify section + simple clients
    return json({
      ok: true,
      answer,
      message: answer,
      session_id,
      model: out.model,
      version: "15.5.1-minimal",
    });
  } catch (e: any) {
    const detail = String(e?.message || e).slice(0, 300);
    console.error("[CHAT_ERROR]", detail);
    return json(
      {
        ok: false,
        error: "AI service unavailable",
        detail,
        hint: "Check Workers AI binding and CHAT_MODEL (prefer @cf/meta/llama-3.1-8b-instruct-fp8)",
      },
      502
    );
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const u = new URL(req.url);
    const path = u.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" || path === "/health") {
      return json({
        ok: true,
        service: "ASTON OS",
        ts: Date.now(),
        version: "15.5.1-minimal",
        profile: env.DEPLOY_PROFILE ?? "minimal",
        routes: ["/health", "/chat", "/v1/chat"],
        chat_model: env.CHAT_MODEL,
        ai_bound: !!env.AI,
      });
    }

    if ((path === "/chat" || path === "/v1/chat") && req.method === "POST") {
      return handleChat(req, env);
    }

    return json({ error: "not found", routes: ["/health", "/chat", "/v1/chat"] }, 404);
  },
} satisfies ExportedHandler<Env>;

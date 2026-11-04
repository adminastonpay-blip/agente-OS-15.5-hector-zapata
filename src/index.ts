import type { Env } from "./types";
import { chat } from "./lib/ai";
import { SessionMemory } from "./do/session";
import {
  VOICE_PROFILES,
  TTS_MODELS,
  applyVoicePersonality,
  inferActions,
  runTts,
} from "./lib/skills";

export { SessionMemory };

const VERSION = "15.5.2-skills";

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

const SYSTEM_CHAT =
  "Eres ASTON OS, asistente de Lane & Aston. Responde en español, claro y breve. No inventes precios ni stock.";

const SYSTEM_SOLVE =
  SYSTEM_CHAT +
  "\nPara problemas complejos: 1) reformulá el objetivo en una línea 2) listá 2-5 pasos 3) indicá la próxima acción 4) mencioná datos que falten.";

async function handleChat(req: Request, env: Env, deep = false): Promise<Response> {
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

    const useDeep = deep || body.mode === "deep" || body.deep === true;

    const stub = env.SESSION.get(env.SESSION.idFromName(session_id));
    let history: any[] = [];
    try {
      const mem = await (await stub.fetch("https://do/get")).json<{ history: any[] }>();
      history = mem.history ?? [];
    } catch {
      history = [];
    }

    // Optional client history (Shopify section) when DO empty
    if (!history.length && Array.isArray(body.history)) {
      history = body.history
        .filter((h: any) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
        .slice(-8);
    }

    const messages = [
      { role: "system", content: useDeep ? SYSTEM_SOLVE : SYSTEM_CHAT },
      ...history.slice(-8).map((h: any) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];

    const out = await chat(env, messages, {
      max_tokens: useDeep ? 1024 : 512,
    });
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

    const actions =
      body.agent?.actions_enabled || body.client?.agent_runtime
        ? inferActions(message)
        : [];

    return json({
      ok: true,
      answer,
      message: answer,
      speech: answer.slice(0, 500),
      session_id,
      model: out.model,
      mode: useDeep ? "deep" : "chat",
      version: VERSION,
      actions: actions.length ? actions : undefined,
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

async function handleTts(req: Request, env: Env): Promise<Response> {
  try {
    const body = await req.json<any>().catch(() => ({}));
    const text =
      (typeof body.text === "string" && body.text.trim()) ||
      (typeof body.message === "string" && body.message.trim()) ||
      "";
    if (!text) return json({ ok: false, error: "text requerido" }, 400);
    if (text.length > 5000) return json({ ok: false, error: "text demasiado largo" }, 413);

    const lang = (typeof body.language === "string" ? body.language : "es").toLowerCase();
    const preferred =
      typeof body.model === "string" && body.model.startsWith("@cf/")
        ? body.model
        : lang.startsWith("en")
          ? "@cf/deepgram/aura-2-en"
          : "@cf/deepgram/aura-2-es";

    const { binary, model, raw } = await runTts(env, text, preferred);
    if (binary) {
      return new Response(binary, {
        status: 200,
        headers: {
          ...CORS,
          "Content-Type": "audio/mpeg",
          "X-ASTON-TTS-Model": model,
        },
      });
    }
    return json({ ok: true, model, audio: raw, format: "unknown" });
  } catch (e: any) {
    return json({ ok: false, error: "TTS unavailable", detail: String(e?.message || e).slice(0, 250) }, 502);
  }
}

async function handleVoice(req: Request, env: Env): Promise<Response> {
  try {
    const body = await req.json<any>().catch(() => ({}));
    const text =
      (typeof body.text === "string" && body.text.trim()) ||
      (typeof body.message === "string" && body.message.trim()) ||
      "";
    if (!text) return json({ ok: false, error: "text requerido" }, 400);

    const profileKey = String(body.profile || body.voice || "aston_executive").toLowerCase();
    const profile = VOICE_PROFILES[profileKey] || VOICE_PROFILES.aston_executive;
    const spoken = applyVoicePersonality(text, profile.pace);
    const preferred =
      typeof body.model === "string" && body.model.startsWith("@cf/") ? body.model : profile.model;

    const { binary, model, raw } = await runTts(env, spoken, preferred);
    if (binary && body.format !== "json") {
      return new Response(binary, {
        status: 200,
        headers: {
          ...CORS,
          "Content-Type": "audio/mpeg",
          "X-ASTON-TTS-Model": model,
          "X-ASTON-Voice-Profile": profile.id,
        },
      });
    }
    return json({
      ok: true,
      profile: profile.id,
      model,
      text_spoken: spoken,
      audio: raw || null,
    });
  } catch (e: any) {
    return json({ ok: false, error: "Voice unavailable", detail: String(e?.message || e).slice(0, 250) }, 502);
  }
}

async function handleValidate(req: Request, _env: Env): Promise<Response> {
  const body = await req.json<any>().catch(() => ({}));
  const accountId =
    (typeof body.account_id === "string" && body.account_id.trim()) ||
    (typeof body.id === "string" && body.id.trim()) ||
    "";
  if (!accountId) return json({ ok: false, error: "account_id required" }, 400);
  return json({
    ok: true,
    valid: true,
    account_id: accountId,
    plan: "free",
    status: "active",
    source: "edge_default",
    version: VERSION,
  });
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
        version: VERSION,
        profile: env.DEPLOY_PROFILE ?? "minimal",
        routes: [
          "/health",
          "/chat",
          "/v1/chat",
          "/v1/solve",
          "/v1/models",
          "/v1/tts",
          "/v1/voice",
          "/v1/voice/profiles",
          "/v1/validate",
          "/v1/capabilities",
        ],
        chat_model: env.CHAT_MODEL,
        ai_bound: !!env.AI,
        skills: ["chat", "solve", "tts", "voice", "validate", "session-memory", "agent-actions"],
      });
    }

    if (path === "/v1/capabilities" && req.method === "GET") {
      return json({
        ok: true,
        version: VERSION,
        skills: {
          chat: { routes: ["/chat", "/v1/chat"], auth: false },
          solve: { routes: ["/v1/solve"], auth: false, note: "deep reasoning mode" },
          tts: { routes: ["/v1/tts"], models: TTS_MODELS },
          voice: { routes: ["/v1/voice"], profiles: Object.keys(VOICE_PROFILES) },
          validate: { routes: ["/v1/validate"], auth: false },
          session: { binding: "SESSION", type: "DurableObject" },
        },
      });
    }

    if (path === "/v1/models" && req.method === "GET") {
      return json({
        ok: true,
        chat_default: env.CHAT_MODEL,
        embed: env.EMBED_MODEL,
        tts: TTS_MODELS,
        voice_profiles: Object.keys(VOICE_PROFILES),
        version: VERSION,
      });
    }

    if ((path === "/chat" || path === "/v1/chat") && req.method === "POST") {
      return handleChat(req, env, false);
    }

    if (path === "/v1/solve" && req.method === "POST") {
      return handleChat(req, env, true);
    }

    if ((path === "/v1/tts" || path === "/v1/speech") && req.method === "POST") {
      return handleTts(req, env);
    }

    if (path === "/v1/voice" && req.method === "POST") {
      return handleVoice(req, env);
    }

    if (path === "/v1/voice/profiles" && req.method === "GET") {
      return json({
        ok: true,
        default: "aston_executive",
        profiles: Object.values(VOICE_PROFILES),
        version: VERSION,
      });
    }

    if (path === "/v1/validate" && req.method === "POST") {
      return handleValidate(req, env);
    }

    return json(
      {
        error: "not found",
        routes: [
          "/health",
          "/chat",
          "/v1/chat",
          "/v1/solve",
          "/v1/models",
          "/v1/tts",
          "/v1/voice",
          "/v1/validate",
        ],
      },
      404
    );
  },
} satisfies ExportedHandler<Env>;

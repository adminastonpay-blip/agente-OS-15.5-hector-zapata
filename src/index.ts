import type { Env } from "./types";
import { chat, chatStream } from "./lib/ai";
import { SessionMemory } from "./do/session";
import { GraphResolver } from "./do/graph-do";
import { Supervisor } from "./do/supervisor";
import { AgentNode } from "./do/agent-node";
import { SimulationTwin } from "./do/simulation";
import { MissionBrain } from "./do/mission-brain";
import { SafetyInterlock } from "./do/safety-interlock";
import {
  VOICE_PROFILES,
  TTS_MODELS,
  applyVoicePersonality,
  inferActions,
  runTts,
} from "./lib/skills";
import { resolveIdentity } from "./lib/identity";
import { handleV21, pillarStatus } from "./routes/v21";
import { handleSovereign } from "./routes/sovereign";
import { handleFactory } from "./routes/factory";
import { handleDefense } from "./routes/defense";
import { handleEconomy } from "./routes/economy";
import { handleInfra } from "./routes/infra";
import { handleProvenance } from "./routes/provenance";
import { handleRisk } from "./routes/risk";
import { handleGovernedAgents } from "./agents/governed";
import { enforceTenantBodyLimit, planFromIdentity } from "./lib/sovereign";

export {
  SessionMemory,
  GraphResolver,
  Supervisor,
  AgentNode,
  SimulationTwin,
  MissionBrain,
  SafetyInterlock,
};

const VERSION = "21.6.1-envelope";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,Accept,X-Aston-Tenant,X-Aston-Plan,X-Sensor-Key,X-Payment,X-402-Payment,X-Aston-Free,X-Require-Payment",
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

async function loadHistory(env: Env, session_id: string, body: any) {
  const stub = env.SESSION.get(env.SESSION.idFromName(session_id));
  let history: any[] = [];
  try {
    const mem = await (await stub.fetch("https://do/get")).json<{ history: any[] }>();
    history = mem.history ?? [];
  } catch {
    history = [];
  }
  if (!history.length && Array.isArray(body.history)) {
    history = body.history
      .filter(
        (h: any) =>
          h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string"
      )
      .slice(-8);
  }
  return { stub, history };
}

async function appendHistory(stub: DurableObjectStub, message: string, answer: string) {
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
}

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
    const { stub, history } = await loadHistory(env, session_id, body);
    const messages = [
      { role: "system", content: useDeep ? SYSTEM_SOLVE : SYSTEM_CHAT },
      ...history.slice(-8).map((h: any) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];
    const out = await chat(env, messages, { max_tokens: useDeep ? 1024 : 512 });
    const answer = out.response || "";
    await appendHistory(stub, message, answer);
    const actions =
      body.agent?.actions_enabled || body.client?.agent_runtime ? inferActions(message) : [];
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
    return json(
      { ok: false, error: "AI service unavailable", detail: String(e?.message || e).slice(0, 300) },
      502
    );
  }
}

async function handleChatStream(req: Request, env: Env): Promise<Response> {
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
    const useDeep = body.mode === "deep" || body.deep === true;
    const { stub, history } = await loadHistory(env, session_id, body);
    const messages = [
      { role: "system", content: useDeep ? SYSTEM_SOLVE : SYSTEM_CHAT },
      ...history.slice(-8).map((h: any) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];
    const { stream, model, mode } = await chatStream(env, messages, {
      max_tokens: useDeep ? 1024 : 512,
    });
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let full = "";
    const sse = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        };
        send("meta", { ok: true, model, stream_mode: mode, session_id, version: VERSION });
        try {
          const reader = stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            let piece = "";
            if (typeof value === "string") piece = value;
            else if (value instanceof Uint8Array) piece = decoder.decode(value, { stream: true });
            else if (value && typeof value === "object") {
              piece =
                (value as any).response ||
                (value as any).text ||
                (value as any).delta?.content ||
                "";
            }
            if (piece) {
              full += piece;
              send("token", { t: piece });
            }
          }
          await appendHistory(stub, message, full);
          send("done", { ok: true, answer: full, session_id, model, version: VERSION });
          controller.close();
        } catch (e: any) {
          send("error", { error: String(e?.message || e).slice(0, 200) });
          controller.close();
        }
      },
    });
    return new Response(sse, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e: any) {
    return json({ ok: false, error: "stream unavailable", detail: String(e?.message || e).slice(0, 250) }, 502);
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
        headers: { ...CORS, "Content-Type": "audio/mpeg", "X-ASTON-TTS-Model": model },
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
    return json({ ok: true, profile: profile.id, model, text_spoken: spoken, audio: raw || null });
  } catch (e: any) {
    return json({ ok: false, error: "Voice unavailable", detail: String(e?.message || e).slice(0, 250) }, 502);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const u = new URL(req.url);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    const identity = await resolveIdentity(req, env);

    const cl = Number(req.headers.get("content-length") || 0);
    if (cl > 0) {
      const gate = enforceTenantBodyLimit(
        identity,
        cl,
        planFromIdentity(identity, req.headers.get("X-Aston-Plan"))
      );
      if (!gate.ok) return json({ ok: false, error: gate.error, limit: gate.limit }, 413);
    }

    if (path === "/" || path === "/health") {
      return json({
        ok: true,
        service: "ASTON OS",
        product: "Aston Risk Fabric",
        ts: Date.now(),
        version: VERSION,
        profile: env.DEPLOY_PROFILE ?? "21.6-envelope",
        pillars: pillarStatus(env),
        risk: {
          assess: "/v1/risk/assess",
          underwrite: "/v1/risk/underwrite",
          envelopes: "/v1/risk/envelopes",
          status: "/v1/risk/status",
        },
        agents: { plans: "/v1/agents/plans" },
        tagline: "Models think. Agents act. Aston decides how much trust they deserve.",
        chat_model: env.CHAT_MODEL,
        ai_bound: !!env.AI,
        skills: [
          "risk-envelope-v1",
          "arr-assess",
          "governed-agents-exposure",
          "decision-provenance",
          "chat",
        ],
      });
    }

    if (path === "/v1/capabilities" && req.method === "GET") {
      return json({
        ok: true,
        version: VERSION,
        pillars: pillarStatus(env),
        risk_fabric: true,
        risk_envelope_v1: true,
        governed_agents: true,
        decision_provenance: true,
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
    if ((path === "/v1/chat/stream" || path === "/chat/stream") && req.method === "POST") {
      return handleChatStream(req, env);
    }
    if (path === "/v1/solve" && req.method === "POST") return handleChat(req, env, true);
    if ((path === "/v1/tts" || path === "/v1/speech") && req.method === "POST") return handleTts(req, env);
    if (path === "/v1/voice" && req.method === "POST") return handleVoice(req, env);
    if (path === "/v1/voice/profiles" && req.method === "GET") {
      return json({ ok: true, default: "aston_executive", profiles: Object.values(VOICE_PROFILES), version: VERSION });
    }
    if (path === "/v1/validate" && req.method === "POST") {
      const body = await req.json<any>().catch(() => ({}));
      const accountId =
        (typeof body.account_id === "string" && body.account_id.trim()) ||
        (typeof body.id === "string" && body.id.trim()) ||
        "";
      if (!accountId) return json({ ok: false, error: "account_id required" }, 400);
      return json({ ok: true, valid: true, account_id: accountId, plan: "free", status: "active", version: VERSION });
    }

    const risk = await handleRisk(path, req, env, identity, json);
    if (risk) return risk;

    const agents = await handleGovernedAgents(path, req, env, identity, json);
    if (agents) return agents;

    const provenance = await handleProvenance(path, req, env, identity, json);
    if (provenance) return provenance;

    const infra = await handleInfra(path, req, env, identity, json);
    if (infra) return infra;

    const economy = await handleEconomy(path, req, env, identity, json);
    if (economy) return economy;

    const defense = await handleDefense(path, req, env, identity, json);
    if (defense) return defense;

    const factory = await handleFactory(path, req, env, identity, json);
    if (factory) return factory;

    const sov = await handleSovereign(path, req, env, identity, json);
    if (sov) return sov;

    const v21 = await handleV21(path, req, env, identity, json);
    if (v21) return v21;

    return json({ error: "not found", version: VERSION }, 404);
  },
} satisfies ExportedHandler<Env>;

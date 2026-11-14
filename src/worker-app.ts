import type { Env } from "./types";
import { chat, chatStream } from "./lib/ai";
import { VOICE_PROFILES, TTS_MODELS, applyVoicePersonality, inferActions, runTts } from "./lib/skills";
import { resolveIdentity } from "./lib/identity";
import { handleV21, pillarStatus } from "./routes/v21";
import { handleSovereign } from "./routes/sovereign";
import { handleFactory } from "./routes/factory";
import { handleDefense } from "./routes/defense";
import { handleEconomy } from "./routes/economy";
import { handleInfra } from "./routes/infra";
import { handleProvenance } from "./routes/provenance";
import { handleRisk } from "./routes/risk";
import { tryScannerRoutes } from "./scanner/routes";
import { handleGovernedAgents } from "./agents/governed";
import { handleStagingAudit } from "./audit/staging-endpoint";
import { isStagingRouteAllowed } from "./audit/staging-route-guard";
import { isOutputSafeForCredentialLeak } from "./safety/chat-output-guard";
import { authorizeApiRequest } from "./security/mvsp-access";
import { checkRequestRateLimit, enforceRequestBodyLimit } from "./security/request-guard";

const VERSION = "21.6.4-enterprise-diagnostic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,Accept,X-Aston-Tenant,X-Aston-Plan,X-Sensor-Key,X-Payment,X-402-Payment,X-Aston-Free,X-Require-Payment",
};

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...SECURITY_HEADERS },
  });

const SYSTEM_CHAT =
  "Eres ASTON OS, asistente de Lane & Aston. Responde en español, claro y breve. No inventes precios ni stock.";

async function loadHistory(env: Env, session_id: string, body: any) {
  let history: any[] = [];
  let stub: DurableObjectStub | null = null;
  if (env.SESSION) {
    try {
      stub = env.SESSION.get(env.SESSION.idFromName(session_id));
      const mem = await (await stub.fetch("https://do/get")).json<{ history: any[] }>();
      history = mem.history ?? [];
    } catch {
      history = [];
      stub = null;
    }
  }
  if (!history.length && Array.isArray(body.history)) {
    history = body.history
      .filter((h: any) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
      .slice(-8);
  }
  return { stub, history };
}

async function appendHistory(stub: DurableObjectStub | null, message: string, answer: string) {
  if (!stub) return;
  try {
    await stub.fetch("https://do/append", { method: "POST", body: JSON.stringify({ role: "user", content: message }) });
    await stub.fetch("https://do/append", { method: "POST", body: JSON.stringify({ role: "assistant", content: answer }) });
  } catch {
    /* ignore */
  }
}

async function handleChat(req: Request, env: Env, deep = false): Promise<Response> {
  try {
    if (!env.AI) return json({ ok: false, error: "AI binding not configured" }, 503);
    const body = await req.json<any>().catch(() => ({}));
    const message =
      typeof body.message === "string" ? body.message.trim() : typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!message) return json({ ok: false, error: "message requerido" }, 400);
    const session_id = typeof body.session_id === "string" && body.session_id ? body.session_id.slice(0, 80) : "default";
    const useDeep = deep || body.mode === "deep" || body.deep === true;
    const { stub, history } = await loadHistory(env, session_id, body);
    const messages = [
      { role: "system", content: SYSTEM_CHAT },
      ...history.slice(-8).map((h: any) => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];
    const out = await chat(env, messages, { max_tokens: useDeep ? 1024 : 512 });
    const answer = out.response || "";
    if (
      env.CHAT_SAFETY_ENFORCED === "true" &&
      String(env.DEPLOY_PROFILE || "").toLowerCase().includes("staging") &&
      !isOutputSafeForCredentialLeak(answer)
    ) {
      return json({ ok: false, error: "chat_output_guard_blocked" }, 502);
    }
    await appendHistory(stub, message, answer);
    const actions = body.agent?.actions_enabled || body.client?.agent_runtime ? inferActions(message) : [];
    return json({
      ok: true,
      answer,
      message: answer,
      speech: answer.slice(0, 500),
      session_id,
      model: out.model,
      mode: useDeep ? "deep" : "chat",
      version: VERSION,
      session_persisted: !!stub,
      actions: actions.length ? actions : undefined,
    });
  } catch (e: any) {
    return json({ ok: false, error: "AI service unavailable", detail: String(e?.message || e).slice(0, 300) }, 502);
  }
}

const app = {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const u = new URL(req.url);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    if (!isStagingRouteAllowed(env.DEPLOY_PROFILE, path)) {
      return json({ ok: false, error: "staging_route_disabled" }, 404);
    }
    const auditResponse = await handleStagingAudit(req, env, handleChat);
    if (auditResponse) return auditResponse;

    const identity = await resolveIdentity(req, env);
    const rate = await checkRequestRateLimit(
      env,
      identity,
      path,
      req.method,
      req.headers.get("CF-Connecting-IP")
    );
    if ("unavailable" in rate) return json({ ok: false, error: "rate_limit_service_unavailable" }, 503);
    if (!rate.allowed) {
      const retryAfter = Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000));
      return new Response(JSON.stringify({ ok: false, error: "rate_limit_exceeded", retry_after_seconds: retryAfter }), {
        status: 429,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...CORS,
          ...SECURITY_HEADERS,
          "Retry-After": String(retryAfter),
        },
      });
    }

    const bounded = await enforceRequestBodyLimit(req, identity);
    if (!bounded.result.ok) {
      return json({ ok: false, error: "request_body_limit_exceeded", limit: bounded.result.limit }, 413);
    }
    req = bounded.request;

    // Public scanner + enterprise attestation (before API auth)
    const scanned = await tryScannerRoutes(path, req.method, req, env);
    if (scanned) return scanned;

    const access = authorizeApiRequest(req, path, identity);
    if (!access.allowed) return json({ ok: false, error: access.error }, access.status);

    if (path === "/" || path === "/health") {
      return json({
        ok: true,
        service: "ASTON OS",
        product: "Aston Risk Fabric",
        ts: Date.now(),
        version: VERSION,
        profile: env.DEPLOY_PROFILE ?? "21.6.4-enterprise-diagnostic",
        pillars: pillarStatus(env),
        bindings: { ai: !!env.AI, session: !!env.SESSION, db: !!env.DB, etl_queue: !!env.ETL_QUEUE },
        enterprise_diagnostic: true,
        routes: { audit: "/v1/audit", scan: "/api/scan" },
        chat_model: env.CHAT_MODEL,
        ai_bound: !!env.AI,
      });
    }

    if (path === "/v1/capabilities" && req.method === "GET") {
      return json({
        ok: true,
        version: VERSION,
        pillars: pillarStatus(env),
        enterprise_diagnostic: true,
        risk_fabric: true,
      });
    }

    if ((path === "/chat" || path === "/v1/chat") && req.method === "POST") return handleChat(req, env, false);
    if ((path === "/v1/chat/stream" || path === "/chat/stream") && req.method === "POST") {
      return json({ ok: false, error: "stream_not_enabled_in_this_build" }, 501);
    }

    if (path === "/v1/tts" && req.method === "POST") {
      try {
        if (!env.AI) return json({ ok: false, error: "AI binding not configured" }, 503);
        const body = await req.json<any>().catch(() => ({}));
        const text =
          (typeof body.text === "string" && body.text.trim()) ||
          (typeof body.message === "string" && body.message.trim()) ||
          "";
        if (!text) return json({ ok: false, error: "text requerido" }, 400);
        const preferred =
          typeof body.model === "string" && body.model.startsWith("@cf/") ? body.model : "@cf/deepgram/aura-2-es";
        const { binary, model, raw } = await runTts(env as Env & { AI: Ai }, text, preferred);
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

export default app;

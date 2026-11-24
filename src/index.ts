import type { Env, Identity } from "./types";
import { handleETLQueue } from "./etl";
import { handleETLIngest } from "./etl-ingest";
import { ControlGate } from "./core/control-gate";
import { ModelRunner } from "./core/model-runner";
import { SessionMemory } from "./do/session";
import { GraphResolver } from "./do/graph-do";
import { Supervisor } from "./do/supervisor";
import { AgentNode } from "./do/agent-node";
import { SimulationTwin } from "./do/simulation";
import { MissionBrain } from "./do/mission-brain";
import { SafetyInterlock } from "./do/safety-interlock";
import { TrustFabric } from "./do/trust-fabric";
import { RecoveryWorkflow } from "./workflows/recovery";
import { MissionTokenVerifier, hashRecoveryMission } from "./core/mission-token";
import { isAllowedRecoveryOrigin } from "./security/recovery-guard";
import { ReplayGuard } from "./core/replay-guard";
import {
  canonicalizeJson,
  fromBase64Url,
  importEd25519PublicKey,
  signInternalAssertion,
  verifyEd25519ProofOfPossession,
  MAX_INTERNAL_ASSERTION_TTL_MS,
} from "./core/attestation";
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
import { handleEngineering } from "./routes/engineering";
import { handleProvenance } from "./routes/provenance";
import { handleRisk } from "./routes/risk";
import { handleGovernedAgents } from "./agents/governed";

import { handleStagingAudit } from "./audit/staging-endpoint";
import { isStagingRouteAllowed } from "./audit/staging-route-guard";
import { isOutputSafeForCredentialLeak } from "./safety/chat-output-guard";
import { authorizeApiRequest } from "./security/mvsp-access";
import { checkRequestRateLimit, enforceRequestBodyLimit } from "./security/request-guard";
import { sessionStorageKey } from "./security/session-key";

type GateWorkerEnv = Env & {
  INTERNAL_ASSERTION_SECRET?: string;
  INTERNAL_ASSERTION_KEY_ID?: string;
};

// Required: exported class names must match wrangler [exports.*] and bindings
export {
  SessionMemory,
  GraphResolver,
  Supervisor,
  AgentNode,
  SimulationTwin,
  MissionBrain,
  SafetyInterlock,
  TrustFabric,
  ReplayGuard,
  RecoveryWorkflow,
};

const VERSION = "21.6.3-cf-audit";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,Accept,X-Aston-Tenant,X-Aston-Plan,X-Sensor-Key,X-Payment,X-402-Payment,X-Aston-Free,X-Require-Payment,X-Aston-Pop-Signature,X-Aston-Pop-Public-Key,X-Aston-Actor",
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
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS,
      ...SECURITY_HEADERS,
    },
  });

const SYSTEM_CHAT =
  "Eres ASTON OS, asistente de Lane & Aston. Responde en español, claro y breve. No inventes precios ni stock.";

const SYSTEM_SOLVE =
  SYSTEM_CHAT +
  "\nPara problemas complejos: 1) reformulá el objetivo en una línea 2) listá 2-5 pasos 3) indicá la próxima acción 4) mencioná datos que falten.";

async function verifyWorkerPopIfPresent(
  req: Request,
  identity: Identity,
  path: string
): Promise<{ ok: true } | { ok: false; status: 401 | 403; error: string }> {
  const sig = req.headers.get("x-aston-pop-signature")?.trim();
  const pubB64Url = req.headers.get("x-aston-pop-public-key")?.trim();
  const claimedTenant = req.headers.get("x-aston-tenant")?.trim();
  const claimedActor = req.headers.get("x-aston-actor")?.trim();

  if (claimedTenant && identity.tenant && claimedTenant !== identity.tenant) {
    return { ok: false, status: 403, error: "tenant_header_mismatch" };
  }
  if (claimedActor && identity.actor && claimedActor !== identity.actor) {
    return { ok: false, status: 403, error: "actor_header_mismatch" };
  }
  if (!sig && !pubB64Url) {
    return { ok: true };
  }
  if (!sig || !pubB64Url) {
    return { ok: false, status: 401, error: "incomplete_pop_headers" };
  }
  if (identity.method === "public" || !identity.tenant || !identity.actor) {
    return { ok: false, status: 403, error: "verified_identity_required_for_pop" };
  }

  try {
    const pubKey = await importEd25519PublicKey(fromBase64Url(pubB64Url));
    const rawBody = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text().catch(() => "");
    const statement = canonicalizeJson({
      method: req.method,
      path,
      tenant: identity.tenant,
      actor: identity.actor,
      body: rawBody,
    });
    const valid = await verifyEd25519ProofOfPossession(pubKey, statement, sig);
    if (!valid) {
      return { ok: false, status: 401, error: "invalid_ed25519_pop_signature" };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 401, error: "malformed_ed25519_pop" };
  }
}

async function createWorkerInternalAssertion(
  env: GateWorkerEnv,
  aud: string,
  identity: Identity
): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; error: string }> {
  const secret = env.INTERNAL_ASSERTION_SECRET;
  const kid = env.INTERNAL_ASSERTION_KEY_ID;
  if (!secret && !kid) return { ok: true, headers: {} };
  if (!secret || !kid) return { ok: false, error: "internal_assertion_config_incomplete" };
  if (!identity.tenant || !identity.actor) return { ok: false, error: "verified_identity_required" };
  try {
    const token = await signInternalAssertion(
      {
        iss: "worker-router",
        aud,
        sub_tenant: identity.tenant,
        sub_actor: identity.actor,
        jti: crypto.randomUUID(),
        ttlMs: MAX_INTERNAL_ASSERTION_TTL_MS,
      },
      secret,
      kid
    );
    return { ok: true, headers: { "x-aston-internal-assertion": token } };
  } catch {
    return { ok: false, error: "internal_assertion_sign_failed" };
  }
}

async function loadHistory(
  env: Env,
  session_id: string,
  body: any,
  identity: Awaited<ReturnType<typeof resolveIdentity>>
): Promise<{ stub: DurableObjectStub | null; history: any[] }> {
  let history: any[] = [];
  let stub: DurableObjectStub | null = null;

  // Soft-fail if SESSION binding is not available (deploy without DOs still serves chat)
  // Anonymous chat never persists history. Authenticated sessions are namespaced
  // by tenant + verified actor + caller session id to prevent cross-user collisions.
  if (env.SESSION && identity.method !== "public") {
    try {
      const storageKey = await sessionStorageKey(identity, session_id);
      stub = env.SESSION.get(env.SESSION.idFromName(storageKey));
      const mem = await (await stub.fetch("https://do/get")).json<{ history: any[] }>();
      history = mem.history ?? [];
    } catch {
      history = [];
      stub = null;
    }
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

async function appendHistory(
  stub: DurableObjectStub | null,
  message: string,
  answer: string
) {
  if (!stub) return;
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
    if (!env.AI) {
      return json({ ok: false, error: "AI binding not configured" }, 503);
    }
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
    const identity = await resolveIdentity(req, env);
    const { stub, history } = await loadHistory(env, session_id, body, identity);
    const messages = [
      { role: "system" as const, content: useDeep ? SYSTEM_SOLVE : SYSTEM_CHAT },
      ...history.slice(-8).map((h: any) => ({
        role: h.role as "user" | "assistant",
        content: h.content,
      })),
      { role: "user" as const, content: message },
    ];
    const authorization = await new ControlGate(env).authorizeChat(identity, messages);
    if (!authorization.ok) {
      return json(
        { ok: false, error: authorization.reason, policy: authorization.policy },
        authorization.status
      );
    }
    const out = await new ModelRunner(env).runChat(authorization.permit, messages, {
      maxTokens: useDeep ? 1024 : 512,
    });
    const answer = out.response || "";
    if (!isOutputSafeForCredentialLeak(answer)) {
      return json({ ok: false, error: "chat_output_guard_blocked" }, 502);
    }
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
      session_persisted: !!stub,
      actions: actions.length ? actions : undefined,
    });
  } catch (e: any) {
    return json(
      { ok: false, error: "AI service unavailable", detail: String(e?.message || e).slice(0, 300) },
      502
    );
  }
}

async function handleChatStream(_req: Request, _env: Env): Promise<Response> {
  // Streaming is disabled until the complete response can be checked before any bytes are released.
  return json({
    ok: false,
    error: "chat_stream_disabled_until_buffered_safety_guard_is_implemented",
  }, 503);
}

async function handleTts(req: Request, env: Env, identity: Awaited<ReturnType<typeof resolveIdentity>>): Promise<Response> {
  try {
    if (!env.AI) return json({ ok: false, error: "AI binding not configured" }, 503);
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
    const { binary, model, raw } = await runTts(env, identity, text, preferred);
    if (binary) {
      return new Response(binary, {
        status: 200,
        headers: { ...CORS, "Content-Type": "audio/mpeg", "X-ASTON-TTS-Model": model },
      });
    }
    return json({ ok: true, model, audio: raw, format: "unknown" });
  } catch (e: any) {
    return json(
      { ok: false, error: "TTS unavailable", detail: String(e?.message || e).slice(0, 250) },
      502
    );
  }
}

async function handleVoice(req: Request, env: Env, identity: Awaited<ReturnType<typeof resolveIdentity>>): Promise<Response> {
  try {
    if (!env.AI) return json({ ok: false, error: "AI binding not configured" }, 503);
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
    const { binary, model, raw } = await runTts(env, identity, spoken, preferred);
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
    return json({ ok: true, profile: profile.id

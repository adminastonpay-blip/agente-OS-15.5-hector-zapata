import type { Env } from "./types";
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
import { RecoveryWorkflow } from "./workflows/recovery";
import { MissionTokenVerifier, hashRecoveryMission } from "./core/mission-token";
import { isAllowedRecoveryOrigin } from "./security/recovery-guard";
import { ReplayGuard } from "./core/replay-guard";
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
import { handleCommand } from "./routes/command";
import { handleEconomy } from "./routes/economy";
import { handleInfra } from "./routes/infra";
import { handleProvenance } from "./routes/provenance";
import { handleRisk } from "./routes/risk";
import { handleGovernedAgents } from "./agents/governed";

import { handleStagingAudit } from "./audit/staging-endpoint";
import { isStagingRouteAllowed } from "./audit/staging-route-guard";
import { isOutputSafeForCredentialLeak } from "./safety/chat-output-guard";
import { authorizeApiRequest } from "./security/mvsp-access";
import { checkRequestRateLimit, enforceRequestBodyLimit } from "./security/request-guard";
import { sessionStorageKey } from "./security/session-key";

export {
  SessionMemory,
  GraphResolver,
  Supervisor,
  AgentNode,
  SimulationTwin,
  MissionBrain,
  SafetyInterlock,
  ReplayGuard,
  RecoveryWorkflow,
};

const VERSION = "21.6.3-cf-audit";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,Accept,X-Aston-Tenant,X-Aston-Plan,X-Sensor-Key,X-Payment,X-402-Payment,X-Aston-Free,X-Require-Payment,X-ASTON-Environment,X-ASTON-Tenant-Id,X-Trace-Id",
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const u = new URL(req.url);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    if (!isStagingRouteAllowed(env.DEPLOY_PROFILE, path)) {
      return json({ ok: false, error: "staging_route_disabled" }, 404);
    }
    const auditResponse = await handleStagingAudit(req, env, async () => json({ ok: false, error: "use_full_index" }, 501));
    if (auditResponse) return auditResponse;
    const identity = await resolveIdentity(req, env);
    const rate = await checkRequestRateLimit(
      env,
      identity,
      path,
      req.method,
      req.headers.get("CF-Connecting-IP")
    );
    if ("unavailable" in rate) {
      return json({ ok: false, error: "rate_limit_service_unavailable" }, 503);
    }
    if (!rate.allowed) {
      return json({ ok: false, error: "rate_limit_exceeded" }, 429);
    }

    const bounded = await enforceRequestBodyLimit(req, identity);
    if (!bounded.result.ok) {
      return json({ ok: false, error: "request_body_limit_exceeded" }, 413);
    }
    req = bounded.request;

    const access = authorizeApiRequest(req, path, identity);
    if (!access.allowed) {
      return json({ ok: false, error: access.error }, access.status);
    }

    if (path === "/" || path === "/health") {
      return json({
        ok: true,
        service: "ASTON OS",
        version: VERSION,
        profile: env.DEPLOY_PROFILE ?? VERSION,
        pillars: pillarStatus(env),
        bindings: { ai: !!env.AI, session: !!env.SESSION, db: !!env.DB, etl_queue: !!env.ETL_QUEUE },
      });
    }

    if (path === "/v1/capabilities" && req.method === "GET") {
      return json({ ok: true, version: VERSION, pillars: pillarStatus(env) });
    }

    const command = await handleCommand(path, req, env, identity, json);
    if (command) return command;

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
  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    await handleETLQueue(batch, env);
  },
} satisfies ExportedHandler<Env>;

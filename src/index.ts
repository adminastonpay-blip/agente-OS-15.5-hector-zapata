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
import { tryScannerRoutes } from "./scanner/routes";
import { handleGovernedAgents } from "./agents/governed";

import { handleStagingAudit } from "./audit/staging-endpoint";
import { isStagingRouteAllowed } from "./audit/staging-route-guard";
import { isOutputSafeForCredentialLeak } from "./safety/chat-output-guard";
import { authorizeApiRequest } from "./security/mvsp-access";
import { checkRequestRateLimit, enforceRequestBodyLimit } from "./security/request-guard";

export {
  SessionMemory,
  GraphResolver,
  Supervisor,
  AgentNode,
  SimulationTwin,
  MissionBrain,
  SafetyInterlock,
};

const VERSION = "21.6.3-cf-audit";

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
  "\\nPara problemas complejos: 1) reformulá el objetivo en una línea 2) listá 2-5 pasos 3) indicá la próxima acción 4) mencioná datos que falten.";

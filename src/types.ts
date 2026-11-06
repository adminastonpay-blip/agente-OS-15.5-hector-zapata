/** Cloudflare Worker Env — all optional resources soft-fail when unbound. */
export interface Env {
  // Required for core chat
  AI: Ai;
  SESSION: DurableObjectNamespace;

  // Durable Objects (bound in wrangler)
  GRAPH?: DurableObjectNamespace;
  SUPERVISOR?: DurableObjectNamespace;
  AGENT?: DurableObjectNamespace;
  SIMULATION?: DurableObjectNamespace;
  MISSION?: DurableObjectNamespace;
  SAFETY?: DurableObjectNamespace;

  // Optional platform resources
  DB?: D1Database;
  VECTORIZE?: VectorizeIndex;
  JOURNAL?: R2Bucket;
  ETL_QUEUE?: Queue;
  MISSIONS?: Queue;
  HYPERDRIVE?: Hyperdrive;

  // Vars / secrets
  AI_GATEWAY_ID?: string;
  CHAT_MODEL: string;
  EMBED_MODEL: string;
  DEPLOY_PROFILE?: string;
  API_KEY?: string;
  PII_HMAC_SECRET?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
}

export interface Identity {
  actor: string;
  method: "access" | "apikey" | "sensor" | "public";
  tenant: string;
  roles: string[];
  clearance: "public" | "internal" | "confidential" | "secret";
}

export interface Mission {
  id: string;
  origin: string;
  pool_id: string;
  error_code: number;
  severity: "low" | "medium" | "high" | "critical";
  created_at: number;
  created_by: string;
}

/** Payload for RecoveryWorkflow (optional Cloudflare Workflows). */
export type MissionParams = Mission;

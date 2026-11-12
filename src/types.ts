/** Cloudflare Worker Env — optional resources soft-fail when unbound. */
export interface Env {
  // AI is expected; chat soft-fails if missing
  AI?: Ai;

  // Durable Objects — optional so deploy works even if binding lags
  SESSION?: DurableObjectNamespace;
  GRAPH?: DurableObjectNamespace;
  SUPERVISOR?: DurableObjectNamespace;
  AGENT?: DurableObjectNamespace;
  SIMULATION?: DurableObjectNamespace;
  MISSION?: DurableObjectNamespace;
  SAFETY?: DurableObjectNamespace;

  // Optional platform resources
  DB?: D1Database;
  /** Dedicated D1 database for the isolated VBC-2030 staging registry. */
  VBC_REGISTRY?: D1Database;
  VECTORIZE?: VectorizeIndex;
  JOURNAL?: R2Bucket;
  /** Dedicated Object-Locked R2 bucket for external audit checkpoints and OTS receipts. */
  AUDIT_ARCHIVE?: R2Bucket;
  /** Dedicated service binding that validates OpenTimestamps proofs against Bitcoin headers. */
  OTS_VERIFIER?: Fetcher;
  ETL_QUEUE?: Queue;
  MISSIONS?: Queue;
  HYPERDRIVE?: Hyperdrive;

  // Vars / secrets
  AI_GATEWAY_ID?: string;
  CHAT_MODEL?: string;
  EMBED_MODEL?: string;
  DEPLOY_PROFILE?: string;
  AUDIT_ENABLED?: string;
  AUDIT_ANCHOR_REQUIRED?: string;
  CHAT_SAFETY_ENFORCED?: string;
  AUDIT_SECRET?: string;
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
  /** Optional plan asserted by a verified identity provider, never by a request header. */
  plan?: "free" | "pro" | "sovereign" | "gov";
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

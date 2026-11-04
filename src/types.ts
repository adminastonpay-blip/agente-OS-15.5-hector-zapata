export interface Env {
  AI: Ai;
  SESSION: DurableObjectNamespace;
  GRAPH?: DurableObjectNamespace;
  SUPERVISOR?: DurableObjectNamespace;
  AGENT?: DurableObjectNamespace;
  SIMULATION?: DurableObjectNamespace;
  MISSION?: DurableObjectNamespace;
  SAFETY?: DurableObjectNamespace;
  DB?: D1Database;
  VECTORIZE?: VectorizeIndex;
  JOURNAL?: R2Bucket;
  ETL_QUEUE?: Queue;
  MISSIONS?: Queue;
  HYPERDRIVE?: Hyperdrive;
  AI_GATEWAY_ID: string;
  CHAT_MODEL: string;
  EMBED_MODEL: string;
  DEPLOY_PROFILE?: string;
  API_KEY?: string;
  PII_HMAC_SECRET?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  CF_ACCOUNT_ID?: string;
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

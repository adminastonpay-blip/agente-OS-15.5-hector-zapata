export interface Env {
  AI: Ai;
  VECTORIZE?: VectorizeIndex;
  DB?: D1Database;
  HYPERDRIVE?: Hyperdrive;
  JOURNAL?: R2Bucket;
  ETL_QUEUE?: Queue<any>;
  MISSIONS?: Queue<any>;
  ETL_DLQ?: Queue<any>;
  MISSIONS_DLQ?: Queue<any>;
  RECOVERY_WF?: Workflow;
  CERTIFIED_EXTRACTION_WF?: Workflow;
  SESSION: DurableObjectNamespace;
  GRAPH: DurableObjectNamespace;
  SUPERVISOR: DurableObjectNamespace;
  AGENT: DurableObjectNamespace;
  SIMULATION: DurableObjectNamespace;
  MISSION: DurableObjectNamespace;
  SAFETY: DurableObjectNamespace;
  API_KEY?: string;
  PII_HMAC_SECRET?: string;
  CF_API_TOKEN?: string;
  AI_GATEWAY_ID: string;
  CHAT_MODEL: string;
  EMBED_MODEL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  CF_ACCOUNT_ID: string;
  DEPLOY_PROFILE?: string;
}

export interface Identity {
  actor: string;
  method: "access" | "apikey" | "sensor";
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

export interface MissionParams {
  origin: string;
  pool_id: string;
  error_code: number;
  severity: Mission["severity"];
  requestedBy: string;
}

/** Cloudflare Worker Env — optional resources soft-fail when unbound. */
export interface Env {
  AI?: Ai;
  SESSION?: DurableObjectNamespace;
  GRAPH?: DurableObjectNamespace;
  SUPERVISOR?: DurableObjectNamespace;
  AGENT?: DurableObjectNamespace;
  SIMULATION?: DurableObjectNamespace;
  MISSION?: DurableObjectNamespace;
  SAFETY?: DurableObjectNamespace;
  REPLAY_GUARD?: DurableObjectNamespace;
  RECOVERY_WORKFLOW?: { create(options: { id?: string; params: MissionParams }): Promise<{ id: string }> };
  DB?: D1Database;
  VECTORIZE?: VectorizeIndex;
  JOURNAL?: R2Bucket;
  AUDIT_ARCHIVE?: R2Bucket;
  OTS_VERIFIER?: Fetcher;
  ETL_QUEUE?: Queue;
  MISSIONS?: Queue;
  HYPERDRIVE?: Hyperdrive;
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
  RECOVERY_ALLOWED_ORIGINS?: string;
  MISSION_TOKEN_PUBLIC_KEY?: string;
}

export interface Identity {
  actor: string;
  method: "access" | "apikey" | "sensor" | "public";
  tenant: string;
  roles: string[];
  clearance: "public" | "internal" | "confidential" | "secret";
  plan?: "free" | "pro" | "sovereign" | "gov";
}

/**
 * Internal authentication evidence. This is not a tenant authorization decision.
 * Keep it separate from Identity because Identity is serialized into existing DO flows.
 */
export type AuthenticatedPrincipal =
  | { kind: "access"; verified: true; principalId: string; issuer: string; subject: string; tenantClaim: string | null; tenantAuthority: "unresolved" }
  | { kind: "api_key" | "sensor"; verified: true; principalId: string; credentialId: string; tenantAuthority: "unresolved" };

export interface AuthenticatedContext {
  identity: Identity;
  principal: AuthenticatedPrincipal | null;
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

export interface MissionParams extends Mission {
  mission_token: string;
}

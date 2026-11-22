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
  /** Tenant-partitioned, SQLite-backed single-use mission token claims. */
  REPLAY_GUARD?: DurableObjectNamespace;
  /** Cloudflare Workflow binding used only by the authenticated Recovery entrypoint. */
  RECOVERY_WORKFLOW?: {
    create(options: { id?: string; params: MissionParams }): Promise<{ id: string }>;
  };

  // Optional platform resources
  DB?: D1Database;
  /** Optional Analytics Engine sink for privacy-safe request spans and metrics. */
  OBSERVABILITY?: AnalyticsEngineDataset;
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
  /** Comma-separated HTTPS origins allowed for recovery HEAD probes. Empty means deny all. */
  RECOVERY_ALLOWED_ORIGINS?: string;
  /** Base64url-encoded raw 32-byte Ed25519 public key; configure out-of-band. */
  MISSION_TOKEN_PUBLIC_KEY?: string;
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

/** Recovery payload carries a signed, narrowly scoped mission token. */
export interface MissionParams extends Mission {
  mission_token: string;
}

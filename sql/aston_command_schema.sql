-- ASTON Command — esquema unificado (extensión D1)
-- Complementa schema.sql de agente-OS-15.5 (tenancy, audit_log, decisions existentes)
-- Entidades: tenants, telemetry_events, decision_records, execution_records

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  isolation_tier TEXT NOT NULL DEFAULT 'TEN-02',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'degraded')),
  allowed_issuers TEXT,
  subject_pattern TEXT,
  credential_sha256_fingerprints TEXT,
  mtls_enabled INTEGER NOT NULL DEFAULT 0,
  autonomy_mode TEXT NOT NULL DEFAULT 'balanced_auto'
    CHECK (autonomy_mode IN ('manual_only', 'balanced_auto', 'strict_containment')),
  interlock_state TEXT NOT NULL DEFAULT 'open'
    CHECK (interlock_state IN ('open', 'write_freeze', 'kill_switch_active')),
  heartbeat_timeout_sec INTEGER NOT NULL DEFAULT 60,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenants_env_status ON tenants(environment, status);

CREATE TABLE IF NOT EXISTS telemetry_events (
  event_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  principal_issuer TEXT,
  principal_subject TEXT,
  credential_sha256 TEXT,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('connector', 'agent', 'edge_waf', 'worker', 'scanner')),
  source_id TEXT,
  host_or_region TEXT,
  category TEXT NOT NULL
    CHECK (category IN ('auth', 'identity', 'ai_behavior', 'network', 'vulnerability', 'config_drift', 'health')),
  severity TEXT NOT NULL
    CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  summary TEXT NOT NULL,
  payload TEXT,
  evidence_r2_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_telem_tenant_time ON telemetry_events(tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_telem_trace ON telemetry_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_telem_sev ON telemetry_events(tenant_id, severity, occurred_at DESC);

CREATE TABLE IF NOT EXISTS decision_records (
  decision_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  source_event_ids TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  risk_score INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  threat_tag TEXT,
  rationale TEXT,
  verdict TEXT NOT NULL
    CHECK (verdict IN ('no_action', 'alert_only', 'execute_auto', 'require_approval', 'suppressed_by_interlock')),
  proposed_actions TEXT
);
CREATE INDEX IF NOT EXISTS idx_dec_tenant_time ON decision_records(tenant_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_dec_trace ON decision_records(trace_id);

CREATE TABLE IF NOT EXISTS execution_records (
  execution_id TEXT PRIMARY KEY,
  decision_id TEXT,
  trace_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  action_type TEXT NOT NULL
    CHECK (action_type IN (
      'revoke_credential', 'isolate_connector', 'rate_limit_origin',
      'freeze_writes', 'collect_forensics', 'rotate_secret', 'set_interlock'
    )),
  target_type TEXT NOT NULL
    CHECK (target_type IN ('principal', 'connector', 'agent', 'endpoint', 'tenant_db')),
  target_id TEXT NOT NULL,
  parameters TEXT,
  execution_mode TEXT NOT NULL
    CHECK (execution_mode IN ('automatic', 'manual_approved', 'interlock_override')),
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'pending_approval', 'running', 'succeeded', 'failed', 'blocked', 'rolled_back')),
  approved_by TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  before_state_hash TEXT,
  after_state_hash TEXT,
  audit_r2_key TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_tenant_status ON execution_records(tenant_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_pending ON execution_records(status, tenant_id) WHERE status = 'pending_approval';
CREATE INDEX IF NOT EXISTS idx_exec_trace ON execution_records(trace_id);

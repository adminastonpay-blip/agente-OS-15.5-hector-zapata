-- ===== Pilar: Semántica / RAG =====
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, source TEXT, chunk TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_sess ON messages(session_id, created_at);

-- ===== Pilar: Ontología =====
CREATE TABLE IF NOT EXISTS object_types (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, properties TEXT NOT NULL, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY, type_id TEXT NOT NULL, tenant TEXT NOT NULL,
  properties TEXT NOT NULL, version INTEGER DEFAULT 1,
  valid_from INTEGER NOT NULL, valid_to INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obj_tenant ON objects(tenant, type_id);
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
  type TEXT NOT NULL, properties TEXT, version INTEGER DEFAULT 1,
  valid_from INTEGER NOT NULL, valid_to INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_tenant_from ON links(tenant, from_id, type);
CREATE INDEX IF NOT EXISTS idx_link_tenant_to ON links(tenant, to_id, type);

-- ===== Pilar: Linaje =====
CREATE TABLE IF NOT EXISTS lineage_events (
  id TEXT PRIMARY KEY, object_id TEXT NOT NULL, parent_ids TEXT,
  transformation TEXT NOT NULL, pipeline_version TEXT NOT NULL,
  model TEXT, actor TEXT, metadata TEXT, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lin_obj ON lineage_events(object_id);

-- ===== Pilar: Swarm =====
CREATE TABLE IF NOT EXISTS swarm_tasks (
  id TEXT PRIMARY KEY, parent_id TEXT, tenant TEXT NOT NULL, role TEXT NOT NULL,
  goal TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER DEFAULT 0,
  result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- ===== Pilar: Simulations =====
CREATE TABLE IF NOT EXISTS simulations (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL, scenario TEXT,
  result TEXT, status TEXT NOT NULL, created_at INTEGER, created_by TEXT
);

-- ===== Pilar: Auditoría =====
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
  action TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT
);

-- Certified Extraction Engine
CREATE TABLE IF NOT EXISTS extraction_certificates (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  document_id TEXT,
  model TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  certified_count INTEGER DEFAULT 0,
  total_count INTEGER DEFAULT 0,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ext_cert_tenant ON extraction_certificates(tenant, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ext_cert_hash ON extraction_certificates(input_hash);

-- ===== Trust Layer: Schema Registry =====
CREATE TABLE IF NOT EXISTS object_type_versions (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  type_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  json_schema TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(tenant, type_id, version)
);
CREATE INDEX IF NOT EXISTS idx_otv_active ON object_type_versions(tenant, type_id, status);

-- ===== Trust Layer: Data Contracts =====
CREATE TABLE IF NOT EXISTS data_contracts (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  source TEXT NOT NULL,
  type_id TEXT NOT NULL,
  owner TEXT,
  frequency TEXT,
  freshness_sla_ms INTEGER,
  quality_rules TEXT,
  failure_action TEXT NOT NULL DEFAULT 'quarantine',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contracts_tenant ON data_contracts(tenant, source);

-- ===== Trust Layer: Quarantine =====
CREATE TABLE IF NOT EXISTS quarantine_objects (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  type_id TEXT NOT NULL,
  properties TEXT NOT NULL,
  errors TEXT NOT NULL,
  quality_score REAL NOT NULL DEFAULT 0,
  source TEXT,
  actor TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quarantine_tenant ON quarantine_objects(tenant, created_at DESC);

-- ===== Access Layer: Policies =====
CREATE TABLE IF NOT EXISTS access_policies (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '*',
  object_type TEXT NOT NULL DEFAULT '*',
  action TEXT NOT NULL DEFAULT 'read',
  purpose TEXT NOT NULL DEFAULT '*',
  clearance TEXT NOT NULL DEFAULT '*',
  effect TEXT NOT NULL DEFAULT 'allow',
  row_filter TEXT,
  restricted_fields TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_policies_tenant ON access_policies(tenant, role, object_type, action);

-- ===== Access Layer: Decision Audit =====
CREATE TABLE IF NOT EXISTS access_decisions (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  purpose TEXT NOT NULL,
  effect TEXT NOT NULL,
  policy_id TEXT,
  reason TEXT,
  resource_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_decisions_tenant ON access_decisions(tenant, created_at DESC);

-- ===== Decision Objects =====
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  alternatives TEXT,
  kpis TEXT,
  simulation_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  owner TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_tenant ON decisions(tenant, status, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_evidence (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  label TEXT,
  metadata TEXT,
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_evidence ON decision_evidence(decision_id, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_feedback (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  outcome TEXT NOT NULL,
  feedback TEXT,
  score REAL,
  measured_at INTEGER,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_feedback ON decision_feedback(decision_id, created_at DESC);

-- ===== Governed Agents: Plans =====
CREATE TABLE IF NOT EXISTS agent_plans (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  budget_calls INTEGER NOT NULL DEFAULT 10,
  budget_cost REAL NOT NULL DEFAULT 0,
  used_calls INTEGER NOT NULL DEFAULT 0,
  used_cost REAL NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_plans_tenant ON agent_plans(tenant, status, created_at DESC);

-- ===== Governed Agents: Actions =====
CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  target_id TEXT,
  payload TEXT,
  estimated_cost REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'proposed',
  result TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  executed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_plan ON agent_actions(plan_id, created_at);

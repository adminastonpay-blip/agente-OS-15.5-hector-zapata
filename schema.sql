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
  id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
  type TEXT NOT NULL, properties TEXT, version INTEGER DEFAULT 1,
  valid_from INTEGER NOT NULL, valid_to INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_from ON links(from_id, type);
CREATE INDEX IF NOT EXISTS idx_link_to ON links(to_id, type);

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

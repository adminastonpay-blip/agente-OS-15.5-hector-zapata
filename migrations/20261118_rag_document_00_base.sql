-- ASTON RAG: establish the canonical documents table before additive migrations.
-- Safe when schema.sql has already been applied; required for a genuinely empty D1.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  source TEXT,
  chunk TEXT,
  created_at INTEGER
);

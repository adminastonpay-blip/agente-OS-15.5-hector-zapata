-- ASTON RAG: make the authoritative D1 document record tenant-aware.
-- Legacy rows receive an empty tenant; ownership is never inferred.
ALTER TABLE documents ADD COLUMN tenant TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_documents_tenant_created
  ON documents(tenant, created_at DESC);

-- ASTON RAG: make the authoritative D1 document record tenant-aware.
-- Legacy rows are assigned an empty tenant deliberately; do NOT infer ownership
-- from source/chunk text or copy them into a tenant namespace without evidence.
ALTER TABLE documents ADD COLUMN tenant TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_documents_tenant_created
  ON documents(tenant, created_at DESC);

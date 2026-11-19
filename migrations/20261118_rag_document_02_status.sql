-- ASTON RAG: track D1-to-Vectorize indexing state.
-- Existing rows default to PENDING_VECTOR; no automatic re-indexing is performed.
ALTER TABLE documents
  ADD COLUMN index_status TEXT DEFAULT 'PENDING_VECTOR';

CREATE INDEX IF NOT EXISTS idx_documents_tenant_index_status_created
  ON documents(tenant, index_status, created_at DESC);

-- Add tenant ownership to lineage only. documents.tenant is added by migration 20261118_rag_document_01_tenant.sql.
ALTER TABLE lineage_events ADD COLUMN tenant TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_lin_tenant_obj_ts
  ON lineage_events(tenant, object_id, ts DESC);

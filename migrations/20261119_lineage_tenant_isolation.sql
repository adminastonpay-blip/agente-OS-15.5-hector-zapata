-- Add tenant ownership to lineage records.
-- Legacy rows receive an empty tenant and are intentionally invisible to tenant-scoped reads
-- until an operator maps them to an authoritative tenant. No ownership is inferred here.
ALTER TABLE lineage_events ADD COLUMN tenant TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_lin_tenant_obj_ts
  ON lineage_events(tenant, object_id, ts DESC);

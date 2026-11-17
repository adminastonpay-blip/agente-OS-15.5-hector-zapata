-- D1 migration: tenant-scope ontology links.
-- Existing rows receive an empty tenant and are intentionally excluded by
-- tenant-scoped queries until an operator can map them to an authoritative owner.
ALTER TABLE links ADD COLUMN tenant TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_link_tenant_from
  ON links(tenant, from_id, type);

CREATE INDEX IF NOT EXISTS idx_link_tenant_to
  ON links(tenant, to_id, type);

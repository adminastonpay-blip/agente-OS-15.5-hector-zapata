-- ASTON authoritative identity bindings v1, staging-only ordered migration.
-- Derived from migrations/20261120_01_tenant_identity_registry.sql.
-- Apply only after 0002_tenant_lifecycle.sql and only to dedicated staging D1.
CREATE TABLE IF NOT EXISTS aston_tenant_identity_bindings (
  binding_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES aston_tenants(tenant_id),
  auth_method TEXT NOT NULL CHECK (auth_method IN ('access','apikey','sensor')),
  issuer TEXT,
  subject TEXT,
  credential_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','suspended','revoked')),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json) AND json_type(capabilities_json) = 'array'),
  audiences_json TEXT NOT NULL CHECK (json_valid(audiences_json) AND json_type(audiences_json) = 'array'),
  not_before INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (auth_method = 'access' AND issuer IS NOT NULL AND length(issuer) BETWEEN 1 AND 255
      AND subject IS NOT NULL AND length(subject) BETWEEN 1 AND 255 AND credential_id IS NULL)
    OR
    (auth_method IN ('apikey','sensor') AND issuer IS NULL AND subject IS NULL
      AND credential_id IS NOT NULL AND length(credential_id) = 71
      AND substr(credential_id,1,7) = 'sha256:')
  ),
  CHECK (not_before IS NULL OR not_before >= 0),
  CHECK (expires_at IS NULL OR expires_at >= 0),
  CHECK (expires_at IS NULL OR not_before IS NULL OR expires_at > not_before)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_aston_identity_access_principal
  ON aston_tenant_identity_bindings(auth_method, issuer, subject)
  WHERE auth_method = 'access';
CREATE UNIQUE INDEX IF NOT EXISTS uq_aston_identity_credential
  ON aston_tenant_identity_bindings(credential_id)
  WHERE credential_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aston_identity_tenant_status
  ON aston_tenant_identity_bindings(tenant_id, status);
CREATE TRIGGER IF NOT EXISTS trg_aston_identity_binding_tenant_active_insert
BEFORE INSERT ON aston_tenant_identity_bindings
WHEN NOT EXISTS (SELECT 1 FROM aston_tenants WHERE tenant_id = NEW.tenant_id AND status = 'active')
BEGIN SELECT RAISE(ABORT, 'IDENTITY_TENANT_NOT_ACTIVE'); END;
CREATE TRIGGER IF NOT EXISTS trg_aston_identity_binding_tenant_active_update
BEFORE UPDATE OF tenant_id, status ON aston_tenant_identity_bindings
WHEN NEW.status = 'active' AND NOT EXISTS (SELECT 1 FROM aston_tenants WHERE tenant_id = NEW.tenant_id AND status = 'active')
BEGIN SELECT RAISE(ABORT, 'IDENTITY_TENANT_NOT_ACTIVE'); END;

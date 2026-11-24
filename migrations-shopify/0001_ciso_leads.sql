-- CISO leads contain encrypted contact payloads only. Never store plaintext PII.
-- Apply only after reviewing the target D1 binding and configuring LEADS_ENCRYPTION_KEY.
CREATE TABLE IF NOT EXISTS ciso_leads (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ciso_leads_email_hash_created
  ON ciso_leads (email_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_ciso_leads_expiry
  ON ciso_leads (expires_at);

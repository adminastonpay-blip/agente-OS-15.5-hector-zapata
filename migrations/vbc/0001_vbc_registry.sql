-- ASTON VBC-2030 Cryptographic Core — D1 registry schema
-- Apply only to the dedicated staging D1 database bound as VBC_REGISTRY.
-- Never point this migration at the production DB.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS audit_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  suite_name TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  created_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  software_hash TEXT NOT NULL CHECK (length(software_hash) = 64 AND software_hash NOT GLOB '*[^0-9a-f]*'),
  target_commit TEXT NOT NULL CHECK (length(target_commit) IN (40, 64) AND target_commit NOT GLOB '*[^0-9a-f]*'),
  expected_test_count INTEGER NOT NULL CHECK (expected_test_count BETWEEN 1 AND 500),
  passed_test_count INTEGER NOT NULL DEFAULT 0 CHECK (passed_test_count >= 0),
  failed_test_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_test_count >= 0),
  manifest_sha256 TEXT CHECK (manifest_sha256 IS NULL OR (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*')),
  manifest_key TEXT,
  CHECK ((status = 'running' AND finished_at IS NULL AND manifest_sha256 IS NULL AND manifest_key IS NULL)
      OR (status = 'failed' AND finished_at IS NOT NULL AND manifest_sha256 IS NULL AND manifest_key IS NULL)
      OR (status = 'succeeded' AND finished_at IS NOT NULL AND manifest_sha256 IS NOT NULL AND manifest_key IS NOT NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS test_results (
  result_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES audit_runs(run_id) ON DELETE RESTRICT,
  test_name TEXT NOT NULL,
  status_http INTEGER NOT NULL CHECK (status_http BETWEEN 100 AND 599),
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, test_name)
) STRICT;

CREATE TABLE IF NOT EXISTS evidence_manifest (
  manifest_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES audit_runs(run_id) ON DELETE RESTRICT,
  manifest_version TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64 AND evidence_hash NOT GLOB '*[^0-9a-f]*'),
  timestamp TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  object_key TEXT NOT NULL UNIQUE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_audit_runs_tenant_created
  ON audit_runs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_runs_status_created
  ON audit_runs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_results_run
  ON test_results (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_test_results_passed
  ON test_results (run_id, passed);
CREATE INDEX IF NOT EXISTS idx_evidence_manifest_hash
  ON evidence_manifest (evidence_hash);

-- Results are append-only. A correction requires a new audit run.
CREATE TRIGGER IF NOT EXISTS test_results_no_update
BEFORE UPDATE ON test_results BEGIN
  SELECT RAISE(ABORT, 'test_results_are_immutable');
END;
CREATE TRIGGER IF NOT EXISTS test_results_no_delete
BEFORE DELETE ON test_results BEGIN
  SELECT RAISE(ABORT, 'test_results_are_immutable');
END;
CREATE TRIGGER IF NOT EXISTS evidence_manifest_no_update
BEFORE UPDATE ON evidence_manifest BEGIN
  SELECT RAISE(ABORT, 'evidence_manifest_is_immutable');
END;
CREATE TRIGGER IF NOT EXISTS evidence_manifest_no_delete
BEFORE DELETE ON evidence_manifest BEGIN
  SELECT RAISE(ABORT, 'evidence_manifest_is_immutable');
END;
CREATE TRIGGER IF NOT EXISTS test_results_only_while_running
BEFORE INSERT ON test_results
WHEN (SELECT status FROM audit_runs WHERE run_id = NEW.run_id) <> 'running'
BEGIN
  SELECT RAISE(ABORT, 'audit_run_not_running');
END;

-- A run's identity and audit target are immutable after creation. A running
-- record may transition exactly once to succeeded or failed.
CREATE TRIGGER IF NOT EXISTS audit_runs_transition_guard
BEFORE UPDATE ON audit_runs
WHEN OLD.status <> 'running'
  OR NEW.run_id <> OLD.run_id
  OR NEW.tenant_id <> OLD.tenant_id
  OR NEW.suite_name <> OLD.suite_name
  OR NEW.suite_version <> OLD.suite_version
  OR NEW.created_at <> OLD.created_at
  OR NEW.started_at <> OLD.started_at
  OR NEW.software_hash <> OLD.software_hash
  OR NEW.target_commit <> OLD.target_commit
  OR NEW.expected_test_count <> OLD.expected_test_count
  OR NEW.status NOT IN ('succeeded', 'failed')
  OR NEW.finished_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'audit_run_is_immutable_or_invalid_transition');
END;

CREATE TRIGGER IF NOT EXISTS audit_runs_no_delete
BEFORE DELETE ON audit_runs BEGIN
  SELECT RAISE(ABORT, 'audit_runs_are_immutable');
END;

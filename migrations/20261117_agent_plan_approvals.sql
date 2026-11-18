-- Durable, single-use human approvals bound to an immutable plan snapshot.
-- Apply only through the normal reviewed migration process; this PR does not apply it.
CREATE TABLE IF NOT EXISTS agent_plan_approvals (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  approver_actor TEXT NOT NULL,
  auth_method TEXT NOT NULL CHECK (auth_method = 'access'),
  access_decision_id TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_plan_approvals_lookup
  ON agent_plan_approvals(tenant, plan_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_plan_approvals_actor
  ON agent_plan_approvals(tenant, approver_actor, created_at DESC);

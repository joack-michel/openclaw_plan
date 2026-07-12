PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN (
    'WAIT_CONFIRM',
    'CONFIRMED',
    'EXECUTING',
    'SUCCEEDED',
    'FAILED',
    'UNKNOWN',
    'RECONCILE_REQUIRED',
    'CANCELLED',
    'EXPIRED'
  )),
  actor_id TEXT,
  account_id TEXT,
  channel_id TEXT,
  session_key TEXT,
  session_id TEXT,
  agent_id TEXT,
  confirmation_scope_key TEXT,
  tool_name TEXT NOT NULL,
  normalized_tool_name TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  frozen_params_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  conflict_scope_hash TEXT NOT NULL,
  reconcile_method TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  executing_at INTEGER,
  completed_at INTEGER,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_params (
  operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id) ON DELETE CASCADE,
  canonical_params_json TEXT NOT NULL,
  display_summary_json TEXT,
  source_metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS execution_attempts (
  execution_attempt_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE,
  run_id TEXT,
  tool_call_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  result_hash TEXT,
  error_text TEXT
);

CREATE TABLE IF NOT EXISTS conflict_locks (
  lock_id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED')),
  acquired_at INTEGER NOT NULL,
  released_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  operation_id TEXT,
  event_type TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT,
  details_json TEXT
);

CREATE TABLE IF NOT EXISTS automation_grants (
  grant_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  cron_job_id TEXT,
  agent_id TEXT NOT NULL,
  automation_spec_hash TEXT NOT NULL,
  authorization_scope_hash TEXT NOT NULL,
  grant_version INTEGER NOT NULL,
  grant_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'ACTIVE',
    'REVIEW_REQUIRED',
    'REVOKED',
    'DISABLED',
    'EXPIRED'
  )),
  allowed_capabilities_json TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL,
  allowed_resources_json TEXT NOT NULL,
  allowed_destinations_json TEXT NOT NULL,
  exact_exec_commands_json TEXT NOT NULL DEFAULT '[]',
  valid_from INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  max_runs_per_period INTEGER NOT NULL,
  period_kind TEXT NOT NULL,
  review_reason TEXT,
  source_job_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_grant_usage (
  grant_id TEXT NOT NULL REFERENCES automation_grants(grant_id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  run_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (grant_id, period_key)
);

CREATE TABLE IF NOT EXISTS automation_grant_runs (
  run_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES automation_grants(grant_id) ON DELETE CASCADE,
  cron_job_id TEXT,
  agent_id TEXT NOT NULL,
  automation_spec_hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'FINISHED', 'FAILED', 'REVOKED')),
  PRIMARY KEY (run_id, session_key)
);

CREATE TABLE IF NOT EXISTS automation_child_grants (
  child_session_key TEXT PRIMARY KEY,
  parent_session_key TEXT NOT NULL,
  parent_grant_id TEXT NOT NULL REFERENCES automation_grants(grant_id) ON DELETE CASCADE,
  effective_grant_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED'))
);

CREATE TABLE IF NOT EXISTS domain_controls (
  domain TEXT PRIMARY KEY,
  paused_until INTEGER NOT NULL,
  reason TEXT,
  source_operation_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS effect_dedupe (
  effect_key TEXT PRIMARY KEY,
  last_attempt_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_idempotency_key
  ON operations(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_operations_context_status
  ON operations(session_key, agent_id, normalized_tool_name, status);

CREATE INDEX IF NOT EXISTS idx_operations_conflict_scope_status
  ON operations(conflict_scope_hash, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_attempts_tool_call
  ON execution_attempts(run_id, tool_call_id)
  WHERE run_id IS NOT NULL AND tool_call_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conflict_locks_active_scope
  ON conflict_locks(scope_type, scope_hash)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_automation_grants_cron_status
  ON automation_grants(cron_job_id, agent_id, status);

CREATE INDEX IF NOT EXISTS idx_automation_grant_runs_session
  ON automation_grant_runs(session_key, status, started_at);

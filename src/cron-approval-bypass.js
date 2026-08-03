import { paramsHash } from "./canonical-json.js";

const DIRECT_CRON_PATTERN = /^agent:([^:]+):cron:([^:]+):run:([^:]+)$/;

export function validateCronApprovalBypassRules(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("cronApprovalBypassRules must be an array");
  const ids = new Set();
  return value.map((rule, index) => {
    if (!isRecord(rule)) throw new Error(`cronApprovalBypassRules[${index}] must be an object`);
    const id = requiredString(rule.id, `cronApprovalBypassRules[${index}].id`);
    if (ids.has(id)) throw new Error(`duplicate cron approval bypass rule id: ${id}`);
    ids.add(id);
    const agentId = requiredString(rule.agentId, `cronApprovalBypassRules[${index}].agentId`);
    const jobIds = explicitStrings(rule.jobIds, `cronApprovalBypassRules[${index}].jobIds`);
    const allowTools = explicitStrings(rule.allowTools, `cronApprovalBypassRules[${index}].allowTools`);
    if (rule.bypassApproval !== true) throw new Error(`cronApprovalBypassRules[${index}].bypassApproval must be true`);
    if (rule.audit !== true) throw new Error(`cronApprovalBypassRules[${index}].audit must be true`);
    if (rule.dedupe !== true) throw new Error(`cronApprovalBypassRules[${index}].dedupe must be true`);
    return Object.freeze({ id, agentId, jobIds: Object.freeze(jobIds), allowTools: Object.freeze(allowTools) });
  });
}

export class CronRunRegistry {
  constructor(operationStore) { this.operationStore = operationStore; }

  ensureSchema() {
    this.operationStore.open();
    this.operationStore.db.exec(`
      CREATE TABLE IF NOT EXISTS trusted_cron_runs (
        run_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        cron_job_id TEXT NOT NULL,
        launch_source TEXT NOT NULL CHECK (launch_source = 'cron'),
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('RUNNING', 'FINISHED', 'FAILED')),
        PRIMARY KEY (run_id, session_key)
      );
      CREATE INDEX IF NOT EXISTS idx_trusted_cron_runs_match
        ON trusted_cron_runs (run_id, session_key, agent_id, cron_job_id, status);
    `);
  }

  bindDirectGatewayCron(ctx = {}, now = Date.now()) {
    const identity = trustedDirectCronIdentity(ctx);
    if (!identity) return { ok: false, reason: "not a direct Gateway cron context" };
    this.operationStore.open();
    this.operationStore.db.prepare(`
      INSERT INTO trusted_cron_runs (run_id, session_key, agent_id, cron_job_id, launch_source, started_at, ended_at, status)
      VALUES (?, ?, ?, ?, 'cron', ?, NULL, 'RUNNING')
      ON CONFLICT(run_id, session_key) DO UPDATE SET
        agent_id = excluded.agent_id,
        cron_job_id = excluded.cron_job_id,
        launch_source = 'cron',
        status = 'RUNNING',
        ended_at = NULL
    `).run(identity.runId, identity.sessionKey, identity.agentId, identity.cronJobId, now);
    return { ok: true, ...identity };
  }

  matchesDirectGatewayCron(ctx = {}, rule) {
    const identity = trustedDirectCronIdentity(ctx);
    if (!identity || !rule || identity.agentId !== rule.agentId || !rule.jobIds.includes(identity.cronJobId)) return null;
    this.operationStore.open();
    const row = this.operationStore.db.prepare(`
      SELECT run_id, session_key, agent_id, cron_job_id FROM trusted_cron_runs
      WHERE run_id = ? AND session_key = ? AND agent_id = ? AND cron_job_id = ?
        AND launch_source = 'cron' AND status = 'RUNNING'
    `).get(identity.runId, identity.sessionKey, identity.agentId, identity.cronJobId);
    return row ? identity : null;
  }

  finish(ctx = {}, success, now = Date.now()) {
    const runId = string(ctx.runId);
    const sessionKey = string(ctx.sessionKey);
    if (!runId || !sessionKey) return 0;
    this.operationStore.open();
    return this.operationStore.db.prepare(`
      UPDATE trusted_cron_runs SET status = ?, ended_at = ?
      WHERE run_id = ? AND session_key = ? AND status = 'RUNNING'
    `).run(success === true ? "FINISHED" : "FAILED", now, runId, sessionKey).changes;
  }
}

export function findMatchingCronApprovalBypass({ rules, event, ctx, registry }) {
  const toolName = string(event?.toolName);
  for (const rule of rules || []) {
    if (!rule.allowTools.includes(toolName)) continue;
    const identity = registry.matchesDirectGatewayCron(ctx, rule);
    if (!identity) continue;
    return { rule, identity, canonicalHash: `sha256:${paramsHash(event?.params || {})}`, businessIdempotencyKey: businessIdempotencyKey(event?.params) };
  }
  return null;
}

function trustedDirectCronIdentity(ctx = {}) {
  if (!isRecord(ctx) || hasDelegation(ctx)) return null;
  const agentId = string(ctx.agentId);
  const runId = string(ctx.runId);
  const sessionKey = string(ctx.sessionKey);
  const match = DIRECT_CRON_PATTERN.exec(sessionKey);
  if (!agentId || !runId || !match || match[1] !== agentId || match[3] !== runId) return null;
  const declaredJobId = string(ctx.jobId || ctx.cronJobId);
  if (declaredJobId && declaredJobId !== match[2]) return null;
  if (ctx.launchSource !== undefined && ctx.launchSource !== "cron") return null;
  return { agentId, runId, sessionKey, cronJobId: match[2] };
}

function hasDelegation(ctx) {
  return ["delegatedByAgentId", "delegatedBy", "parentAgentId", "parentAgent", "parentRunId", "parentRun", "parentSessionKey", "parentSession", "requesterSessionKey", "requesterAgentId"].some((key) => string(ctx[key]));
}
function requiredString(value, label) { const text = string(value); if (!text || text === "*") throw new Error(`${label} must be a non-empty explicit string`); return text; }
function explicitStrings(value, label) { if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`); return value.map((item, index) => requiredString(item, `${label}[${index}]`)); }
function businessIdempotencyKey(params) { if (!isRecord(params)) return ""; return string(params.businessIdempotencyKey || params.idempotencyKey || params.idempotency_key || params.requestId || params.request_id); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function string(value) { return typeof value === "string" ? value.trim() : ""; }

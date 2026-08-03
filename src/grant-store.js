import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isRecord, stableStringify } from "./canonical-json.js";
import { buildAutomationGrantFromCron, intersectScopes } from "./automation-scope.js";
import { destinationKey } from "./destination-identity.js";

export class GrantStore {
  constructor(operationStore) {
    this.operationStore = operationStore;
  }

  get db() {
    this.operationStore.open();
    return this.operationStore.db;
  }

  migrateEnabledCrons(jobs, now = Date.now()) {
    this.operationStore.open();
    const grants = [];
    const skipped = [];
    return this.operationStore.transaction(() => {
      for (const job of jobs) {
        if (job.enabled !== true) {
          skipped.push({ cronJobId: job.id, name: job.name || "", reason: "disabled" });
          continue;
        }
        const grant = buildAutomationGrantFromCron(job, now);
        this.upsertGrant(grant, now);
        grants.push(grant);
      }
      return { grants, skipped };
    });
  }

  upsertGrant(grant, now = Date.now()) {
    const existing = this.db.prepare("SELECT * FROM automation_grants WHERE grant_id = ?").get(grant.grantId);
    if (!existing) {
      this.db.prepare(`
        INSERT INTO automation_grants (
          grant_id, owner_id, automation_id, cron_job_id, agent_id, automation_spec_hash,
          authorization_scope_hash, grant_version, grant_hash, status,
          allowed_capabilities_json, allowed_tools_json, allowed_resources_json,
          allowed_destinations_json, exact_exec_commands_json, valid_from, valid_until,
          max_runs_per_period, period_kind, review_reason, source_job_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        grant.grantId,
        grant.ownerId,
        grant.automationId,
        grant.cronJobId,
        grant.agentId,
        grant.automationSpecHash,
        grant.authorizationScopeHash,
        grant.grantVersion,
        grant.grantHash,
        grant.status,
        stableStringify(grant.allowedCapabilities),
        stableStringify(grant.allowedTools),
        stableStringify(grant.allowedResources),
        stableStringify(grant.allowedDestinations),
        stableStringify(grant.exactExecCommands || []),
        now,
        4_102_444_800_000,
        grant.maxRunsPerPeriod,
        grant.periodKind,
        grant.reviewReason,
        stableStringify(grant.sourceJobJson),
        grant.createdAt,
        grant.updatedAt
      );
      this.auditGrant(grant.grantId, "automation_grant.created", grant.status, { cronJobId: grant.cronJobId, reviewReason: grant.reviewReason });
      return;
    }
    const oldScope = {
      capabilities: parseJson(existing.allowed_capabilities_json, []),
      tools: parseJson(existing.allowed_tools_json, []),
      resources: parseJson(existing.allowed_resources_json, []),
      destinations: parseJson(existing.allowed_destinations_json, [])
    };
    const newScope = {
      capabilities: grant.allowedCapabilities,
      tools: grant.allowedTools,
      resources: grant.allowedResources,
      destinations: grant.allowedDestinations
    };
    const status = grant.status === "REVIEW_REQUIRED" || !isScopeSubsetLocal(newScope, oldScope)
      ? "REVIEW_REQUIRED"
      : existing.status;
    this.db.prepare(`
      UPDATE automation_grants
      SET automation_spec_hash = ?, authorization_scope_hash = ?, grant_hash = ?,
          status = ?, allowed_capabilities_json = ?, allowed_tools_json = ?,
          allowed_resources_json = ?, allowed_destinations_json = ?, exact_exec_commands_json = ?,
          review_reason = ?, source_job_json = ?, updated_at = ?
      WHERE grant_id = ?
    `).run(
      grant.automationSpecHash,
      grant.authorizationScopeHash,
      grant.grantHash,
      status,
      stableStringify(grant.allowedCapabilities),
      stableStringify(grant.allowedTools),
      stableStringify(grant.allowedResources),
      stableStringify(grant.allowedDestinations),
      stableStringify(grant.exactExecCommands || []),
      status === "REVIEW_REQUIRED" ? (grant.reviewReason || "authorization scope expanded") : "",
      stableStringify(grant.sourceJobJson),
      now,
      grant.grantId
    );
    this.auditGrant(grant.grantId, "automation_grant.updated", status, { cronJobId: grant.cronJobId });
  }

  bindAutomationRun({ event = {}, ctx = {}, job, now = Date.now() }) {
    const cronJobId = ctx.jobId || event.jobId || parseCronJobId(ctx.sessionKey);
    if (!cronJobId) return { ok: false, reason: "cron job id missing" };
    const grant = this.findActiveGrantForCron(cronJobId, ctx.agentId || event.agentId || "");
    if (!grant.ok) return grant;
    return this.startGrantRun({
      grant: grant.grant,
      runId: ctx.runId || event.runId || "",
      sessionKey: ctx.sessionKey || event.sessionKey || "",
      cronJobId,
      agentId: ctx.agentId || event.agentId || grant.grant.agent_id,
      now
    });
  }

  startGrantRun({ grant, runId, sessionKey, cronJobId, agentId, now = Date.now() }) {
    this.operationStore.open();
    if (!runId || !sessionKey) return { ok: false, reason: "runId or sessionKey missing" };
    return this.operationStore.transaction(() => {
      const fresh = this.db.prepare("SELECT * FROM automation_grants WHERE grant_id = ?").get(grant.grant_id);
      if (!fresh || fresh.status !== "ACTIVE") return { ok: false, reason: "grant is not active" };
      const existingRun = this.db.prepare("SELECT grant_id, status, ended_at FROM automation_grant_runs WHERE run_id = ? AND session_key = ?").get(runId, sessionKey);
      if (existingRun) {
        if (existingRun.grant_id === fresh.grant_id && existingRun.status === "RUNNING") {
          return { ok: true, grantId: fresh.grant_id, reused: true };
        }
        // OpenClaw may emit agent_end between provider failover attempts while
        // retaining the same cron run/session identity. Rebind that exact run
        // without consuming quota again; no other session or grant can inherit it.
        if (existingRun.grant_id === fresh.grant_id && ["FINISHED", "FAILED"].includes(existingRun.status) && now - Number(existingRun.ended_at || 0) <= 5 * 60_000) {
          this.db.prepare(`
            UPDATE automation_grant_runs
            SET status = 'RUNNING', ended_at = NULL
            WHERE run_id = ? AND session_key = ? AND grant_id = ?
          `).run(runId, sessionKey, fresh.grant_id);
          this.auditGrant(fresh.grant_id, "automation_grant.run_rebound", "RUNNING", { runId, sessionKey, cronJobId });
          return { ok: true, grantId: fresh.grant_id, reused: true, rebound: true };
        }
        return { ok: false, reason: `automation run already exists with status ${existingRun.status}` };
      }
      const periodKey = periodKeyFor(fresh.period_kind, now);
      this.db.prepare(`
        INSERT INTO automation_grant_usage(grant_id, period_key, run_count, updated_at)
        VALUES(?, ?, 0, ?)
        ON CONFLICT(grant_id, period_key) DO NOTHING
      `).run(fresh.grant_id, periodKey, now);
      const quota = this.db.prepare(`
        UPDATE automation_grant_usage
        SET run_count = run_count + 1, updated_at = ?
        WHERE grant_id = ? AND period_key = ? AND run_count < ?
      `).run(now, fresh.grant_id, periodKey, fresh.max_runs_per_period);
      if (quota.changes !== 1) return { ok: false, reason: "grant run quota exceeded" };
      this.db.prepare(`
        INSERT OR IGNORE INTO automation_grant_runs (
          run_id, session_key, grant_id, cron_job_id, agent_id, automation_spec_hash, started_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING')
      `).run(runId, sessionKey, fresh.grant_id, cronJobId, agentId, fresh.automation_spec_hash, now);
      this.auditGrant(fresh.grant_id, "automation_grant.run_started", "RUNNING", { runId, sessionKey, cronJobId });
      return { ok: true, grantId: fresh.grant_id };
    });
  }

  finishAutomationRun({ runId = "", sessionKey = "", success, error = "", now = Date.now() }) {
    this.operationStore.open();
    if (!runId && !sessionKey) return { ok: false, reason: "runId or sessionKey required" };
    const status = success === true ? "FINISHED" : "FAILED";
    const result = this.db.prepare(`
      UPDATE automation_grant_runs
      SET status = ?, ended_at = ?
      WHERE status = 'RUNNING'
        AND (? = '' OR run_id = ?)
        AND (? = '' OR session_key = ?)
    `).run(status, now, runId, runId, sessionKey, sessionKey);
    if (result.changes > 0) {
      this.auditGrant(null, "automation_run.completed", status, { runId, sessionKey, error: String(error || "").slice(0, 500) });
    }
    return { ok: true, status, changes: result.changes };
  }

  reconcileStaleRuns({ cronRuns = [], now = Date.now(), staleAfterMs = 15 * 60_000 } = {}) {
    this.operationStore.open();
    const bySession = new Map(cronRuns.filter((row) => row?.session_id).map((row) => [String(row.session_id), row]));
    const byJob = new Map();
    for (const row of cronRuns) {
      if (!row?.job_id) continue;
      const list = byJob.get(String(row.job_id)) || [];
      list.push(row);
      byJob.set(String(row.job_id), list);
    }
    const stale = this.db.prepare("SELECT * FROM automation_grant_runs WHERE status = 'RUNNING' AND started_at <= ? ORDER BY started_at").all(now - staleAfterMs);
    const results = [];
    for (const run of stale) {
      const sessionLog = bySession.get(run.run_id) || bySession.get(String(run.session_key).split(":run:").pop());
      const jobLog = (byJob.get(String(run.cron_job_id)) || [])
        .filter((row) => Math.abs(Number(row.run_at_ms || row.ts || 0) - Number(run.started_at)) <= 60 * 60_000)
        .sort((a, b) => Math.abs(Number(a.run_at_ms || a.ts || 0) - Number(run.started_at)) - Math.abs(Number(b.run_at_ms || b.ts || 0) - Number(run.started_at)))[0];
      const log = sessionLog || jobLog;
      const status = log?.status === "ok" ? "FINISHED" : "FAILED";
      const endedAt = Number(log?.ts || now);
      this.db.prepare("UPDATE automation_grant_runs SET status = ?, ended_at = ? WHERE run_id = ? AND session_key = ? AND status = 'RUNNING'").run(status, endedAt, run.run_id, run.session_key);
      this.auditGrant(run.grant_id, "automation_run.reconciled", status, {
        runId: run.run_id,
        cronJobId: run.cron_job_id,
        evidence: log ? "cron_run_logs" : "stale timeout without completion log",
        cronStatus: log?.status || null
      });
      results.push({ runId: run.run_id, status, evidence: log ? "cron_run_logs" : "stale timeout" });
    }
    return results;
  }

  evaluateToolCall({ event, ctx = {}, capability }) {
    const grant = this.resolveGrantForContext(ctx);
    if (!grant.ok) return { action: "NO_GRANT", reason: grant.reason };
    const fresh = this.db.prepare("SELECT * FROM automation_grants WHERE grant_id = ?").get(grant.grantId);
    if (!fresh || fresh.status !== "ACTIVE") return { action: "DENY", reason: "automation grant is not active" };
    const allowedCapabilities = parseJson(fresh.allowed_capabilities_json, []);
    const allowedTools = parseJson(fresh.allowed_tools_json, []);
    const allowedResources = parseJson(fresh.allowed_resources_json, []);
    const allowedDestinations = parseJson(fresh.allowed_destinations_json, []);
    const exactExecCommands = parseJson(fresh.exact_exec_commands_json, []);
    const toolName = String(event?.toolName || "").trim();

    if (capability.kind === "SEND_MESSAGE" || capability.kind === "SEND_SELF_NOTIFICATION") {
      if (!capability.destination || !allowedDestinations.includes(destinationKey(capability.destination))) {
        return { action: "OUT_OF_SCOPE", reason: "message destination is outside automation grant" };
      }
      if (!allowedCapabilities.includes("SEND_SELF_NOTIFICATION")) {
        return { action: "OUT_OF_SCOPE", reason: "self notification is not granted" };
      }
      return { action: "ALLOW", grantId: fresh.grant_id };
    }
    if (capability.kind === "SEND_THIRD_PARTY_MESSAGE") {
      return { action: "OUT_OF_SCOPE", reason: "third-party message destination is outside automation grant" };
    }

    if (!capabilityGranted(capability.kind, allowedCapabilities)) {
      return { action: "OUT_OF_SCOPE", reason: `${capability.kind} is outside automation grant` };
    }
    if (toolName !== "exec" && !allowedTools.includes(toolName) && !isImplicitToolAllowed(toolName, capability.kind)) {
      return { action: "OUT_OF_SCOPE", reason: `${toolName} is outside automation grant tools` };
    }
    if (toolName === "exec") {
      const commandForScope = capability.fixedCommand || capability.command;
      if (!allowedTools.includes("exec")) {
        return { action: "OUT_OF_SCOPE", reason: "exec is outside automation grant tools" };
      }
      if (capability.kind === "ARBITRARY_EXEC" || capability.kind === "CONFIG_MUTATION" || capability.kind === "DELETE") {
        return { action: "OUT_OF_SCOPE", reason: `${capability.kind} is not allowed by automation grant` };
      }
      if (capability.scriptIdentity && !allowedResources.includes(capability.resourceKey) && !exactExecCommands.includes(commandForScope)) {
        return { action: "OUT_OF_SCOPE", reason: "exec script identity is outside automation grant" };
      }
      const scriptResourceMatched = Boolean(capability.scriptIdentity && allowedResources.includes(capability.resourceKey));
      if (exactExecCommands.length > 0 && !exactExecCommands.includes(commandForScope) && !scriptResourceMatched) {
        return { action: "OUT_OF_SCOPE", reason: "exec command does not match the automation grant fixed command" };
      }
    }
    if (toolName !== "exec" && allowedResources.length && !resourceAllowed(capability, allowedResources)) {
      return { action: "OUT_OF_SCOPE", reason: "resource is outside automation grant" };
    }
    return { action: "ALLOW", grantId: fresh.grant_id };
  }

  createChildGrantByIntersection({ event = {}, ctx = {}, requested }) {
    const parent = this.resolveGrantForContext({ sessionKey: ctx.requesterSessionKey || event.requesterSessionKey });
    if (!parent.ok) return { ok: false, reason: parent.reason };
    const grant = this.db.prepare("SELECT * FROM automation_grants WHERE grant_id = ?").get(parent.grantId);
    if (!grant) return { ok: false, reason: "parent grant not found" };
    const parentScope = {
      capabilities: parseJson(grant.allowed_capabilities_json, []),
      tools: parseJson(grant.allowed_tools_json, []),
      resources: parseJson(grant.allowed_resources_json, []),
      destinations: parseJson(grant.allowed_destinations_json, [])
    };
    const effective = intersectScopes(parentScope, requested);
    const childSessionKey = event.childSessionKey || ctx.childSessionKey;
    if (!childSessionKey) return { ok: false, reason: "child session key missing" };
    this.db.prepare(`
      INSERT OR REPLACE INTO automation_child_grants (
        child_session_key, parent_session_key, parent_grant_id, effective_grant_json, created_at, expires_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')
    `).run(childSessionKey, ctx.requesterSessionKey || event.requesterSessionKey || "", parent.grantId, stableStringify(effective), Date.now(), Date.now() + 86_400_000);
    return { ok: true, effective };
  }

  resolveGrantForContext(ctx = {}) {
    const runId = ctx.runId || "";
    const sessionKey = ctx.sessionKey || "";
    if (runId && sessionKey) {
      const row = this.db.prepare("SELECT grant_id FROM automation_grant_runs WHERE run_id = ? AND session_key = ? AND status = 'RUNNING'").get(runId, sessionKey);
      if (row) return { ok: true, grantId: row.grant_id };
    }
    if (sessionKey) {
      const row = this.db.prepare("SELECT grant_id FROM automation_grant_runs WHERE session_key = ? AND status = 'RUNNING' ORDER BY started_at DESC LIMIT 1").get(sessionKey);
      if (row) return { ok: true, grantId: row.grant_id };
      const child = this.db.prepare("SELECT parent_grant_id FROM automation_child_grants WHERE child_session_key = ? AND status = 'ACTIVE' AND expires_at > ?").get(sessionKey, Date.now());
      if (child) return { ok: true, grantId: child.parent_grant_id };
    }
    return { ok: false, reason: "no automation grant context" };
  }

  findActiveGrantForCron(cronJobId, agentId = "") {
    const row = this.db.prepare(`
      SELECT * FROM automation_grants
      WHERE cron_job_id = ? AND status = 'ACTIVE'
        AND (? = '' OR agent_id = ?)
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(cronJobId, agentId, agentId);
    return row ? { ok: true, grant: row } : { ok: false, reason: "active grant not found" };
  }

  revokeGrant(grantId, now = Date.now()) {
    const result = this.db.prepare("UPDATE automation_grants SET status = 'REVOKED', updated_at = ? WHERE grant_id = ?").run(now, grantId);
    return { ok: result.changes === 1 };
  }

  listGrants() {
    return this.db.prepare("SELECT grant_id, cron_job_id, agent_id, status, allowed_capabilities_json, review_reason FROM automation_grants ORDER BY cron_job_id").all();
  }

  auditGrant(grantId, eventType, status, details) {
    this.db.prepare(`
      INSERT INTO audit_log (ts, operation_id, event_type, old_status, new_status, details_json)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).run(Date.now(), grantId, eventType, status, stableStringify(details || {}));
  }
}

export function loadCronJobsFromOpenClaw() {
  const output = execFileSync("openclaw", ["cron", "list", "--all", "--json"], { encoding: "utf8", timeout: 20_000 });
  const parsed = JSON.parse(stripTrailingConfigWarning(output));
  return Array.isArray(parsed.jobs) ? parsed.jobs : [];
}

export function loadCronJobsFromFile(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(parsed.jobs) ? parsed.jobs : Array.isArray(parsed) ? parsed : [];
}

export function parseCronJobId(sessionKey = "") {
  const match = /:cron:([^:]+):run:/.exec(String(sessionKey || ""));
  return match ? match[1] : "";
}

function isImplicitToolAllowed(toolName, capability) {
  if (capability === "READ_WORKSPACE_SAFE") return toolName === "read" || toolName === "dir_list";
  if (capability === "QUERY_EXTERNAL") return /(^|__)query|(^|__)list|(^|__)get|(^|__)available|status/i.test(toolName);
  if (capability === "CLAIM_COUPON") return /coupon|redeem|auto-bind/i.test(toolName);
  if (capability === "MCDONALDS_QUERY_COUPON") return /^mcd-mcp__(?:available-coupons|query-my-account|query-(?:my-|store-)?coupons|query-order)$/i.test(toolName);
  if (capability === "MCDONALDS_CLAIM_COUPON") return /^mcd-mcp__(?:auto-bind-coupons|claim|redeem)/i.test(toolName);
  if (capability === "WRITE_OWN_MEMORY_STATE") return toolName === "write" || toolName === "edit" || toolName === "apply_patch";
  return false;
}

function resourceAllowed(capability, allowedResources) {
  if (allowedResources.includes("*")) return true;
  if (capability.kind === "CLAIM_COUPON" && allowedResources.includes("coupon:*")) return true;
  if ((capability.kind === "MEITUAN_CLAIM_COUPON" || capability.kind === "MEITUAN_QUERY_COUPON") && allowedResources.includes("meituan:coupon:*")) return true;
  if ((capability.kind === "MCDONALDS_CLAIM_COUPON" || capability.kind === "MCDONALDS_QUERY_COUPON") && allowedResources.includes("mcdonalds:coupon:own")) return true;
  if (capability.kind === "READ_WORKSPACE_SAFE" && allowedResources.includes("workspace:safe-read")) return true;
  if (capability.kind === "WRITE_OWN_MEMORY_STATE" && allowedResources.includes("memory-state:own")) return true;
  return allowedResources.includes(capability.resourceKey);
}

function capabilityGranted(kind, allowedCapabilities) {
  if (allowedCapabilities.includes(kind)) return true;
  return false;
}

function periodKeyFor(kind, now) {
  const date = new Date(now);
  if (kind === "month") return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function isScopeSubsetLocal(candidate, base) {
  for (const key of ["capabilities", "tools", "resources", "destinations"]) {
    const baseSet = new Set(base[key] || []);
    if ((candidate[key] || []).some((value) => !baseSet.has(value))) return false;
  }
  return true;
}

function stripTrailingConfigWarning(output) {
  const text = String(output || "").trim();
  const end = text.lastIndexOf("}");
  return end >= 0 ? text.slice(0, end + 1) : text;
}

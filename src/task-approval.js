import { newId, sha256Hex, stableStringify } from "./canonical-json.js";

const DEFAULT_TASK_TTL_MS = 30 * 60_000; // 30 minutes max fallback
const NEVER_OPERATIONS = new Set([
  "FINANCIAL_STEP_UP",
  "secret-export-step-up",
  "security-core",
]);

export class TaskApprovalStore {
  constructor(operationStore) {
    this.operationStore = operationStore;
  }

  get db() {
    this.operationStore.open();
    return this.operationStore.db;
  }

  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_approvals (
        task_approval_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL,
        parent_agent_id TEXT NOT NULL DEFAULT '',
        first_operation_id TEXT NOT NULL DEFAULT '',
        risk_ceiling TEXT NOT NULL DEFAULT 'L2',
        gateway_boot_id TEXT NOT NULL,
        task_summary TEXT NOT NULL,
        allowed_capabilities_json TEXT NOT NULL DEFAULT '[]',
        allowed_tools_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_task_approvals_lookup
        ON task_approvals(task_id, actor_id, channel_id, session_id, agent_id, status);
      CREATE INDEX IF NOT EXISTS idx_task_approvals_boot
        ON task_approvals(gateway_boot_id, status);
    `);
  }

  createTaskApproval({ taskId, identity, firstOperationId = "", riskCeiling = "L2", taskSummary, allowedCapabilities = [], allowedTools = [], ttlMs = DEFAULT_TASK_TTL_MS, now = Date.now() }) {
    this.ensureSchema();
    const approvalId = newId("task_approval");
    const expiresAt = now + ttlMs;
    this.db.prepare(`
      INSERT INTO task_approvals (
        task_approval_id, task_id, actor_id, channel_id, session_id, run_id, agent_id, parent_agent_id, first_operation_id, risk_ceiling,
        gateway_boot_id, task_summary, allowed_capabilities_json, allowed_tools_json,
        status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      approvalId, taskId,
      identity.actorId || '', identity.channelId || '', identity.sessionId || '', identity.runId || '', identity.agentId || '', identity.parentAgentId || '', firstOperationId, riskCeiling,
      identity.gatewayBootId,
      taskSummary,
      stableStringify(allowedCapabilities),
      stableStringify(allowedTools),
      now, expiresAt
    );
    return { approvalId, taskId, expiresAt };
  }

  findActiveTaskApproval({ taskId, identity, now = Date.now() }) {
    this.ensureSchema();
    return this.db.prepare(`
      SELECT * FROM task_approvals
      WHERE task_id = ?
        AND actor_id = ?
        AND channel_id = ?
        AND session_id = ?
        AND run_id = ?
        AND (agent_id = ? OR agent_id = ?)
        AND gateway_boot_id = ?
        AND status = 'active'
        AND expires_at > ?
      LIMIT 1
    `).get(
      taskId,
      identity.actorId || '', identity.channelId || '', identity.sessionId || '', identity.runId || '', identity.agentId || '', identity.parentAgentId || '',
      identity.gatewayBootId,
      now
    ) || null;
  }

  canCover(taskApproval, { capability, toolName }) {
    if (!taskApproval || taskApproval.status !== "active") return false;
    const allowedCaps = JSON.parse(taskApproval.allowed_capabilities_json || "[]");
    const allowedTools = JSON.parse(taskApproval.allowed_tools_json || "[]");

    // Never cover protected operations
    if (NEVER_OPERATIONS.has(capability?.kind)) return false;
    if (capability?.riskLevel === "L4") return false;

    // The child agent inherits only this stored intersection.  A config such
    // as alsoAllow:["exec"] never becomes a blanket exec authorization.
    if (taskApproval.risk_ceiling === "L1" && capability?.riskLevel && capability.riskLevel !== "L0" && capability.riskLevel !== "L1") return false;
    // Check explicit tool match
    if (allowedTools.includes(toolName)) return true;

    // Check capability kind match
    if (capability?.kind && allowedCaps.includes(capability.kind)) return true;

    // Check MCP source-level match: e.g. "mcp:mcd-mcp:read"
    const source = mcpSource(toolName);
    if (source && allowedCaps.some((c) => c === `mcp:${source}:read` || c === `mcp:${source}:any`)) {
      if (isReadCapability(capability)) return true;
    }

    // Check generic capability ranges
    if (capability?.kind === "READ_WORKSPACE_SAFE" && allowedCaps.includes("workspace:read")) return true;
    if (capability?.kind === "QUERY_EXTERNAL" && allowedCaps.includes("mcp:query:read")) return true;

    return false;
  }

  endTaskApproval(taskId, { now = Date.now() } = {}) {
    this.ensureSchema();
    const result = this.db.prepare(`
      UPDATE task_approvals SET status = 'ended', ended_at = ?
      WHERE task_id = ? AND status = 'active'
    `).run(now, taskId);
    return result.changes > 0;
  }

  endAllForBoot(gatewayBootId, { now = Date.now() } = {}) {
    this.ensureSchema();
    const result = this.db.prepare(`
      UPDATE task_approvals SET status = 'expired', ended_at = ?
      WHERE gateway_boot_id = ? AND status = 'active'
    `).run(now, gatewayBootId);
    return result.changes;
  }

  endAllForSession(sessionId, { now = Date.now() } = {}) {
    this.ensureSchema();
    const result = this.db.prepare(`
      UPDATE task_approvals SET status = 'expired', ended_at = ?
      WHERE session_id = ? AND status = 'active'
    `).run(now, sessionId);
    return result.changes;
  }

  expireStale({ now = Date.now() } = {}) {
    this.ensureSchema();
    const result = this.db.prepare(`
      UPDATE task_approvals SET status = 'expired', ended_at = ?
      WHERE status = 'active' AND expires_at <= ?
    `).run(now, now);
    return result.changes;
  }
}

export function resolveTaskId(ctx = {}, event = {}) {
  // Prefer runId as the stable task identifier through the tool-call chain
  const runId = ctx.runId || event.runId || "";
  if (runId) return runId;

  // Fall back to a composite of session + turn/message identifiers
  const turnId = ctx.turnId || event.turnId || ctx.messageId || event.messageId || "";
  const sessionKey = ctx.sessionKey || event.sessionKey || "";
  if (turnId && sessionKey) return sha256Hex(`${sessionKey}:${turnId}`);

  // Last resort: sessionKey alone
  if (sessionKey) return sha256Hex(`session:${sessionKey}`);

  return null;
}

export function resolveIdentity(ctx = {}, event = {}, bootId = "") {
  return {
    actorId: firstString(ctx.senderId, event.senderId, ctx.actorId, event.actorId),
    channelId: firstString(ctx.channelId, event.channelId),
    sessionId: firstString(ctx.sessionId, event.sessionId, ctx.sessionKey, event.sessionKey),
    runId: firstString(ctx.runId, event.runId),
    agentId: firstString(ctx.agentId, event.agentId),
    parentAgentId: firstString(ctx.parentAgentId, event.parentAgentId, ctx.parent?.agentId, event.parent?.agentId),
    gatewayBootId: bootId,
  };
}

export function buildTaskSummary({ event, decision, displayNote }) {
  if (displayNote && typeof displayNote === "string") {
    return displayNote.slice(0, 500);
  }
  const toolName = String(event?.toolName || "");
  const opType = decision?.operationType || "";
  if (opType === "exec") return "在服务器上执行命令完成任务。";
  if (opType === "cron-mutation") return "管理自动任务配置。";
  if (toolName.includes("__")) {
    const source = toolName.split("__")[0];
    return `调用 ${source} 服务完成任务。`;
  }
  return "完成你刚才提出的请求。";
}

export function buildAllowedCapabilities({ event, decision, toolName }) {
  const caps = [];
  const source = mcpSource(toolName);

  if (source && isReadCapability(decision)) {
    caps.push(`mcp:${source}:read`);
  }
  if (decision?.kind === "READ_WORKSPACE_SAFE") {
    caps.push("workspace:read");
  }
  if (decision?.kind === "QUERY_EXTERNAL") {
    caps.push("mcp:query:read");
  }
  if (toolName) caps.push(toolName);
  if (decision?.kind) caps.push(decision.kind);

  return caps;
}

function mcpSource(toolName) {
  const t = String(toolName || "");
  const idx = t.indexOf("__");
  return idx > 0 ? t.slice(0, idx) : "";
}

function isReadCapability(decision) {
  if (!decision) return false;
  const readKinds = new Set([
    "QUERY_EXTERNAL", "READ_WORKSPACE_SAFE", "READ_AUTOMATION_STATE",
    "MEITUAN_QUERY_COUPON", "MCDONALDS_QUERY_COUPON",
  ]);
  const readOpTypes = new Set([
    "readonly", "query-status", "meituan-query-coupon", "mcdonalds-query-coupon",
  ]);
  return readKinds.has(decision.kind) || readOpTypes.has(decision.operationType);
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalParamsJson, isRecord, newId, paramsHash, sha256Hex, stableStringify } from "./canonical-json.js";
import { buildConfirmationScope, buildConfirmationScopeKey } from "./confirmation-scope.js";

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"]);

export class OperationStore {
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath;
    this.schemaPath = options.schemaPath || new URL("../sql/schema.sql", import.meta.url);
    this.db = null;
  }

  open() {
    if (this.db) {
      return;
    }
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(readFileSync(this.schemaPath, "utf8"));
    this.applyLightweightMigrations();
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  createOperation({ event, ctx = {}, decision, taskId = "", ttlMs = 900_000, displayNote = null, now = Date.now() }) {
    this.open();
    const operationId = newId("op");
    const paramsJson = canonicalParamsJson(event.params);
    const frozenHash = sha256Hex(paramsJson);
    const scope = buildConfirmationScope(event, ctx);
    const confirmationScopeKey = buildConfirmationScopeKey(event, ctx);
    const idempotencyKey = sha256Hex(stableStringify({
      confirmationScopeKey,
      toolName: event.toolName,
      paramsHash: frozenHash
    }));
    const conflictScopeHash = sha256Hex(decision.conflictScope || `${decision.operationType}:${paramsJson}`);
    const expiresAt = now + ttlMs;

    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO operations (
          operation_id, status, actor_id, account_id, channel_id, session_key, session_id, agent_id, confirmation_scope_key,
          task_id, tool_name, normalized_tool_name, operation_type, risk_level, frozen_params_hash,
          idempotency_key, conflict_scope_hash, reconcile_method, created_at, updated_at, expires_at
        ) VALUES (?, 'WAIT_CONFIRM', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operationId,
        scope.actorId,
        scope.accountId,
        scope.channelId,
        scope.sessionKey,
        ctx.sessionId || "",
        scope.agentId,
        confirmationScopeKey,
        taskId,
        event.toolName,
        decision.toolName,
        decision.operationType,
        decision.riskLevel,
        frozenHash,
        idempotencyKey,
        conflictScopeHash,
        decision.reconcileMethod || "",
        now,
        now,
        expiresAt
      );
      this.db.prepare(`
        INSERT INTO operation_params (operation_id, canonical_params_json, display_summary_json, source_metadata_json)
        VALUES (?, ?, ?, ?)
      `).run(operationId, paramsJson, displayNote ? stableStringify(displayNote) : null, stableStringify({
        source: decision.source,
        reason: decision.reason,
        toolName: event.toolName,
        toolCallId: event.toolCallId || ctx.toolCallId || "",
        normalizedArguments: JSON.parse(paramsJson),
        actorId: scope.actorId,
        channelId: scope.channelId,
        sessionId: ctx.sessionId || "",
        canonicalHash: `sha256:${frozenHash}`,
        resultRoute: { runId: ctx.runId || event.runId || "", sessionKey: scope.sessionKey }
      }));
      this.audit(operationId, "operation.created", null, "WAIT_CONFIRM", { toolName: event.toolName, reason: decision.reason });
    });

    return { operationId, frozenHash, idempotencyKey, conflictScopeHash, expiresAt, displayNote };
  }

  getOperation(operationId) {
    this.open();
    return this.db.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId);
  }

  getDisplayNote(operationId) {
    this.open();
    const row = this.db.prepare("SELECT display_summary_json FROM operation_params WHERE operation_id = ?").get(operationId);
    return row && row.display_summary_json ? JSON.parse(row.display_summary_json) : null;
  }

  getCanonicalRequest(operationId, expectedToolName = "") {
    this.open();
    const row = this.db.prepare(`SELECT o.*, p.canonical_params_json FROM operations o JOIN operation_params p ON p.operation_id = o.operation_id WHERE o.operation_id = ?`).get(operationId);
    if (!row || (expectedToolName && row.tool_name !== expectedToolName)) return null;
    return row;
  }

  getExecutingOperationByToolCall(toolName, toolCallId) {
    this.open();
    if (!toolCallId) return null;
    return this.db.prepare(`SELECT o.operation_id FROM operations o JOIN execution_attempts a ON a.operation_id = o.operation_id WHERE o.tool_name = ? AND a.tool_call_id = ? AND o.status = 'EXECUTING' ORDER BY a.started_at DESC LIMIT 1`).get(toolName, toolCallId) || null;
  }

  findPendingByContext({ event = {}, ctx = {}, toolName, params, now = Date.now() }) {
    this.open();
    const hash = paramsHash(params);
    const scopeKey = buildConfirmationScopeKey(event, ctx);
    return this.db.prepare(`
      SELECT * FROM operations
      WHERE confirmation_scope_key = ?
        AND tool_name = ?
        AND frozen_params_hash = ?
        AND expires_at > ?
        AND status IN ('WAIT_CONFIRM', 'CONFIRMED', 'EXECUTING', 'UNKNOWN', 'RECONCILE_REQUIRED')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(scopeKey, toolName, hash, now);
  }

  findPendingByTask({ taskId, ctx = {}, now = Date.now() }) {
    if (!taskId) return null;
    this.open();
    const scopeKey = buildConfirmationScopeKey({}, ctx);
    return this.db.prepare(`
      SELECT * FROM operations
      WHERE task_id = ? AND confirmation_scope_key = ? AND status = 'WAIT_CONFIRM' AND expires_at > ?
      ORDER BY created_at ASC LIMIT 1
    `).get(taskId, scopeKey, now) || null;
  }

  confirmOperation({ operationId, ctx = {}, now = Date.now() }) {
    this.open();
    return this.transaction(() => {
      const op = this.getOperation(operationId);
      if (!op) {
        return { ok: false, reason: "operation not found" };
      }
      if (op.status !== "WAIT_CONFIRM") {
        return { ok: false, reason: `operation status is ${op.status}` };
      }
      if (op.expires_at <= now) {
        this.db.prepare("UPDATE operations SET status = 'EXPIRED', updated_at = ? WHERE operation_id = ? AND status = 'WAIT_CONFIRM'").run(now, operationId);
        this.audit(operationId, "operation.expired", "WAIT_CONFIRM", "EXPIRED", {});
        return { ok: false, reason: "operation expired" };
      }
      if (op.session_key && ctx.sessionKey && op.session_key !== ctx.sessionKey) {
        return { ok: false, reason: "session mismatch" };
      }
      const result = this.db.prepare(`
        UPDATE operations
        SET status = 'CONFIRMED', confirmed_at = ?, updated_at = ?
        WHERE operation_id = ? AND status = 'WAIT_CONFIRM'
      `).run(now, now, operationId);
      if (result.changes !== 1) {
        return { ok: false, reason: "confirmation CAS failed" };
      }
      this.audit(operationId, "operation.confirmed", "WAIT_CONFIRM", "CONFIRMED", {});
      return { ok: true, operationId };
    });
  }

  listConfirmableOperations({ event = {}, ctx = {}, now = Date.now(), limit = 10 }) {
    this.open();
    const scopeKey = buildConfirmationScopeKey(event, ctx);
    return this.db.prepare(`
      SELECT o.*, p.canonical_params_json
      FROM operations o
      LEFT JOIN operation_params p ON p.operation_id = o.operation_id
      WHERE o.status = 'WAIT_CONFIRM'
        AND (o.confirmation_scope_key = ? OR (o.session_key = ? AND COALESCE(o.channel_id, '') = '' AND COALESCE(o.actor_id, '') = ''))
        AND o.expires_at > ?
      ORDER BY o.created_at DESC, o.operation_id DESC
      LIMIT ?
    `).all(scopeKey, buildConfirmationScope(event, ctx).sessionKey, now, limit);
  }

  findRecentlyConsumedByScope({ event = {}, ctx = {}, now = Date.now(), windowMs = 300_000 }) {
    this.open();
    const scopeKey = buildConfirmationScopeKey(event, ctx);
    return this.db.prepare(`
      SELECT operation_id, status FROM operations
      WHERE (confirmation_scope_key = ? OR (session_key = ? AND COALESCE(channel_id, '') = '' AND COALESCE(actor_id, '') = ''))
        AND status IN ('CONFIRMED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'RECONCILE_REQUIRED', 'CANCELLED')
        AND updated_at >= ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(scopeKey, buildConfirmationScope(event, ctx).sessionKey, now - windowMs) || null;
  }

  confirmOperationStrict({ operationId, event = {}, ctx = {}, canonicalHash = "", now = Date.now() }) {
    this.open();
    return this.transaction(() => {
      const scopeKey = buildConfirmationScopeKey(event, ctx);
      const op = this.db.prepare(`
        SELECT o.*, p.canonical_params_json
        FROM operations o
        LEFT JOIN operation_params p ON p.operation_id = o.operation_id
        WHERE o.operation_id = ?
      `).get(operationId);
      if (!op) {
        return { ok: false, reason: "operation not found" };
      }
      if (op.status !== "WAIT_CONFIRM") return { ok: false, reason: "ALREADY_CONSUMED" };
      if (canonicalHash !== `sha256:${op.frozen_params_hash}`) return { ok: false, reason: "HASH_MISMATCH" };
      if (op.expires_at <= now) {
        this.db.prepare("UPDATE operations SET status = 'EXPIRED', updated_at = ? WHERE operation_id = ? AND status = 'WAIT_CONFIRM'").run(now, operationId);
        this.audit(operationId, "operation.expired", "WAIT_CONFIRM", "EXPIRED", {});
        return { ok: false, reason: "operation expired" };
      }
      if (op.confirmation_scope_key !== scopeKey && !(op.session_key && op.session_key === buildConfirmationScope(event, ctx).sessionKey && !op.channel_id && !op.actor_id)) {
        return { ok: false, reason: "confirmation scope mismatch" };
      }
      if (op.session_id && ctx.sessionId && op.session_id !== ctx.sessionId) return { ok: false, reason: "session mismatch" };
      const result = this.db.prepare(`
        UPDATE operations
        SET status = 'CONFIRMED', confirmed_at = ?, updated_at = ?
        WHERE operation_id = ? AND status = 'WAIT_CONFIRM'
      `).run(now, now, operationId);
      if (result.changes !== 1) {
        return { ok: false, reason: "confirmation CAS failed" };
      }
      this.audit(operationId, "operation.confirmed", "WAIT_CONFIRM", "CONFIRMED", {});
      return { ok: true, operationId, operation: op, scopeLimitations: [] };
    });
  }

  cancelOperationStrict({ operationId, event = {}, ctx = {}, canonicalHash = "", now = Date.now() }) {
    this.open();
    return this.transaction(() => {
      const scopeKey = buildConfirmationScopeKey(event, ctx);
      const op = this.db.prepare(`
        SELECT * FROM operations WHERE operation_id = ?
      `).get(operationId);
      if (!op) return { ok: false, reason: "operation not found" };
      if (op.status !== "WAIT_CONFIRM") return { ok: false, reason: "ALREADY_CONSUMED" };
      if (canonicalHash !== `sha256:${op.frozen_params_hash}`) return { ok: false, reason: "HASH_MISMATCH" };
      if (op.expires_at <= now) {
        this.db.prepare("UPDATE operations SET status = 'EXPIRED', updated_at = ?, completed_at = ? WHERE operation_id = ? AND status = 'WAIT_CONFIRM'").run(now, now, operationId);
        this.audit(operationId, "operation.expired", "WAIT_CONFIRM", "EXPIRED", {});
        return { ok: false, reason: "operation expired" };
      }
      if (op.confirmation_scope_key !== scopeKey && !(op.session_key && op.session_key === buildConfirmationScope(event, ctx).sessionKey && !op.channel_id && !op.actor_id)) {
        return { ok: false, reason: "confirmation scope mismatch" };
      }
      if (op.session_id && ctx.sessionId && op.session_id !== ctx.sessionId) return { ok: false, reason: "session mismatch" };
      const result = this.db.prepare(`
        UPDATE operations SET status = 'CANCELLED', updated_at = ?, completed_at = ?
        WHERE operation_id = ? AND status = 'WAIT_CONFIRM'
      `).run(now, now, operationId);
      if (result.changes !== 1) return { ok: false, reason: "cancellation CAS failed" };
      this.audit(operationId, "operation.cancelled", "WAIT_CONFIRM", "CANCELLED", { reason: "user-denied" });
      return { ok: true, operationId, status: "CANCELLED" };
    });
  }

  findRecentCancellationByContext({ event = {}, ctx = {}, toolName, params, now = Date.now(), windowMs = 600_000 }) {
    this.open();
    const scopeKey = buildConfirmationScopeKey(event, ctx);
    return this.db.prepare(`
      SELECT operation_id, status, updated_at FROM operations
      WHERE confirmation_scope_key = ?
        AND tool_name = ?
        AND frozen_params_hash = ?
        AND status = 'CANCELLED'
        AND updated_at >= ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(scopeKey, toolName, paramsHash(params), now - windowMs) || null;
  }

  beginExecution({ operationId, event, ctx = {}, now = Date.now() }) {
    this.open();
    return this.transaction(() => {
      const op = this.getOperation(operationId);
      return this.beginExecutionInTransaction({ op, operationId, event, ctx, now });
    });
  }

  claimConfirmedByContext({ event, ctx = {}, now = Date.now() }) {
    this.open();
    return this.transaction(() => {
      const scopeKey = buildConfirmationScopeKey(event, ctx);
      const hash = paramsHash(event.params);
      const rows = this.db.prepare(`
        SELECT * FROM operations
        WHERE confirmation_scope_key = ?
          AND tool_name = ?
          AND frozen_params_hash = ?
          AND status = 'CONFIRMED'
          AND expires_at > ?
        ORDER BY confirmed_at ASC
        LIMIT 2
      `).all(scopeKey, event.toolName, hash, now);
      if (rows.length === 0) {
        return { ok: false, reason: "no confirmed operation" };
      }
      if (rows.length > 1) {
        return { ok: false, reason: "multiple confirmed operations match context" };
      }
      return this.beginExecutionInTransaction({
        op: rows[0],
        operationId: rows[0].operation_id,
        event,
        ctx,
        now,
        scopeLimitations: []
      });
    });
  }

  beginExecutionInTransaction({ op, operationId, event, ctx = {}, now = Date.now(), scopeLimitations = [] }) {
    if (!op) return { ok: false, reason: "operation not found" };
    if (op.status === "UNKNOWN" || op.status === "RECONCILE_REQUIRED") {
      return { ok: false, reason: "operation requires reconcile before retry" };
    }
    if (op.status !== "CONFIRMED") {
      return { ok: false, reason: `operation status is ${op.status}` };
    }
    if (op.tool_name !== event.toolName) {
      return { ok: false, reason: "tool mismatch" };
    }
    if (op.frozen_params_hash !== paramsHash(event.params)) {
      return { ok: false, reason: "frozen params hash mismatch" };
    }
    if (op.expires_at <= now) {
      this.db.prepare("UPDATE operations SET status = 'EXPIRED', updated_at = ? WHERE operation_id = ? AND status = 'CONFIRMED'").run(now, operationId);
      this.audit(operationId, "operation.expired", "CONFIRMED", "EXPIRED", {});
      return { ok: false, reason: "operation expired" };
    }
    const lockId = newId("lock");
    try {
      this.db.prepare(`
        INSERT INTO conflict_locks (lock_id, scope_type, scope_hash, operation_id, status, acquired_at)
        VALUES (?, ?, ?, ?, 'ACTIVE', ?)
      `).run(lockId, op.operation_type, op.conflict_scope_hash, operationId, now);
    } catch (err) {
      return { ok: false, reason: `conflict lock unavailable: ${String(err.message || err)}` };
    }
    const attemptId = newId("attempt");
    const updated = this.db.prepare(`
      UPDATE operations
      SET status = 'EXECUTING', executing_at = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'CONFIRMED'
    `).run(now, now, operationId);
    if (updated.changes !== 1) {
      this.releaseLock(lockId, now);
      return { ok: false, reason: "execution CAS failed" };
    }
    this.db.prepare(`
      INSERT INTO execution_attempts (execution_attempt_id, operation_id, run_id, tool_call_id, status, started_at)
      VALUES (?, ?, ?, ?, 'STARTED', ?)
    `).run(attemptId, operationId, ctx.runId || event.runId || null, ctx.toolCallId || event.toolCallId || null, now);
    this.audit(operationId, "operation.executing", "CONFIRMED", "EXECUTING", { attemptId, lockId, scopeLimitations });
    return { ok: true, operationId, executionAttemptId: attemptId, lockId };
  }

  completeAttempt({ operationId, runId, toolCallId, status, result, error, now = Date.now() }) {
    this.open();
    const finalStatus = normalizeFinalStatus(status, error);
    return this.transaction(() => {
      const op = this.getOperation(operationId);
      if (!op) return { ok: false, reason: "operation not found" };
      if (TERMINAL_STATUSES.has(op.status)) {
        return { ok: true, alreadyTerminal: true, status: op.status };
      }
      const attempt = this.db.prepare(`
        SELECT * FROM execution_attempts
        WHERE operation_id = ?
        ORDER BY started_at DESC
        LIMIT 1
      `).get(operationId);
      if (attempt) {
        this.db.prepare(`
          UPDATE execution_attempts
          SET status = ?, finished_at = ?, result_hash = ?, error_text = ?
          WHERE execution_attempt_id = ?
        `).run(
          finalStatus === "SUCCEEDED" ? "SUCCEEDED" : finalStatus === "FAILED" ? "FAILED" : "UNKNOWN",
          now,
          result === undefined ? null : sha256Hex(stableStringify(result)),
          error ? String(error.message || error) : null,
          attempt.execution_attempt_id
        );
      }
      this.db.prepare(`
        UPDATE operations
        SET status = ?, updated_at = ?, completed_at = ?
        WHERE operation_id = ? AND status IN ('EXECUTING', 'CONFIRMED')
      `).run(finalStatus, now, now, operationId);
      if (finalStatus === "SUCCEEDED" || finalStatus === "FAILED") {
        this.db.prepare(`
          UPDATE conflict_locks
          SET status = 'RELEASED', released_at = ?
          WHERE operation_id = ? AND status = 'ACTIVE'
        `).run(now, operationId);
      }
      this.audit(operationId, "operation.completed", op.status, finalStatus, { runId, toolCallId });
      if (finalStatus === "SUCCEEDED" && op.operation_type === "meituan-order") {
        this.db.prepare(`
          INSERT INTO domain_controls(domain, paused_until, reason, source_operation_id, updated_at)
          VALUES('meituan-order-payment', ?, 'successful order cooldown', ?, ?)
          ON CONFLICT(domain) DO UPDATE SET paused_until=excluded.paused_until, reason=excluded.reason,
            source_operation_id=excluded.source_operation_id, updated_at=excluded.updated_at
        `).run(now + 3_600_000, operationId, now);
        this.audit(operationId, "meituan.order_payment_paused", null, "PAUSED", { pausedUntil: now + 3_600_000 });
      }
      return { ok: true, status: finalStatus };
    });
  }

  markStaleExecutingUnknown({ olderThanMs, now = Date.now() }) {
    this.open();
    const cutoff = now - olderThanMs;
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT operation_id FROM operations WHERE status = 'EXECUTING' AND executing_at < ?").all(cutoff);
      for (const row of rows) {
        this.db.prepare("UPDATE operations SET status = 'UNKNOWN', updated_at = ? WHERE operation_id = ? AND status = 'EXECUTING'").run(now, row.operation_id);
        this.audit(row.operation_id, "operation.stale_unknown", "EXECUTING", "UNKNOWN", {});
      }
      return rows.length;
    });
  }

  markReconciled({ operationId, succeeded, now = Date.now() }) {
    this.open();
    const status = succeeded ? "SUCCEEDED" : "FAILED";
    return this.transaction(() => {
      const op = this.getOperation(operationId);
      if (!op) return { ok: false, reason: "operation not found" };
      if (op.status !== "UNKNOWN" && op.status !== "RECONCILE_REQUIRED") {
        return { ok: false, reason: `operation status is ${op.status}` };
      }
      this.db.prepare("UPDATE operations SET status = ?, updated_at = ?, completed_at = ? WHERE operation_id = ?").run(status, now, now, operationId);
      this.db.prepare("UPDATE conflict_locks SET status = 'RELEASED', released_at = ? WHERE operation_id = ? AND status = 'ACTIVE'").run(now, operationId);
      this.audit(operationId, "operation.reconciled", op.status, status, {});
      return { ok: true, status };
    });
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  audit(operationId, eventType, oldStatus, newStatus, details) {
    this.db.prepare(`
      INSERT INTO audit_log (ts, operation_id, event_type, old_status, new_status, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(Date.now(), operationId, eventType, oldStatus, newStatus, stableStringify(details || {}));
  }

  auditSystem(eventType, details, now = Date.now()) {
    this.open();
    this.db.prepare(`INSERT INTO audit_log (ts, operation_id, event_type, old_status, new_status, details_json) VALUES (?, NULL, ?, NULL, NULL, ?)`)
      .run(now, eventType, stableStringify(details || {}));
  }

  getMeituanPause(now = Date.now()) {
    this.open();
    const row = this.db.prepare("SELECT * FROM domain_controls WHERE domain = 'meituan-order-payment'").get();
    return row && row.paused_until > now ? { paused: true, ...row } : { paused: false, paused_until: row?.paused_until || 0 };
  }

  resumeMeituanOrderPayment(now = Date.now()) {
    this.open();
    this.db.prepare(`
      INSERT INTO domain_controls(domain, paused_until, reason, source_operation_id, updated_at)
      VALUES('meituan-order-payment', 0, 'explicit user resume', NULL, ?)
      ON CONFLICT(domain) DO UPDATE SET paused_until=0, reason='explicit user resume', source_operation_id=NULL, updated_at=excluded.updated_at
    `).run(now);
    this.auditSystem("meituan.order_payment_resumed", { explicitUserRequest: true }, now);
    return { ok: true };
  }

  claimEffectDedupe(effectKey, windowMs, now = Date.now()) {
    this.open();
    return this.transaction(() => {
      const row = this.db.prepare("SELECT last_attempt_at FROM effect_dedupe WHERE effect_key = ?").get(effectKey);
      if (row && now - row.last_attempt_at < windowMs) {
        return { ok: false, retryAfterMs: windowMs - (now - row.last_attempt_at) };
      }
      this.db.prepare(`
        INSERT INTO effect_dedupe(effect_key, last_attempt_at, updated_at) VALUES(?, ?, ?)
        ON CONFLICT(effect_key) DO UPDATE SET last_attempt_at=excluded.last_attempt_at, updated_at=excluded.updated_at
      `).run(effectKey, now, now);
      return { ok: true };
    });
  }

  releaseLock(lockId, now) {
    this.db.prepare("UPDATE conflict_locks SET status = 'RELEASED', released_at = ? WHERE lock_id = ?").run(now, lockId);
  }

  applyLightweightMigrations() {
    const columns = this.db.prepare("PRAGMA table_info(automation_grants)").all().map((row) => row.name);
    if (columns.length > 0 && !columns.includes("exact_exec_commands_json")) {
      this.db.exec("ALTER TABLE automation_grants ADD COLUMN exact_exec_commands_json TEXT NOT NULL DEFAULT '[]'");
    }
    const operationColumns = this.db.prepare("PRAGMA table_info(operations)").all().map((row) => row.name);
    if (!operationColumns.includes("confirmation_scope_key")) {
      this.db.exec("ALTER TABLE operations ADD COLUMN confirmation_scope_key TEXT");
    }
    if (!operationColumns.includes("task_id")) this.db.exec("ALTER TABLE operations ADD COLUMN task_id TEXT NOT NULL DEFAULT ''");
    const legacy = this.db.prepare("SELECT * FROM operations WHERE confirmation_scope_key IS NULL OR confirmation_scope_key = ''").all();
    for (const op of legacy) {
      const key = buildConfirmationScopeKey({}, {
        sessionKey: op.session_key,
        agentId: op.agent_id,
        channelId: op.channel_id,
        accountId: op.account_id,
        senderId: op.actor_id
      });
      this.db.prepare("UPDATE operations SET confirmation_scope_key = ? WHERE operation_id = ?").run(key, op.operation_id);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_operations_confirmation_scope_status ON operations(confirmation_scope_key, status, expires_at, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_operations_task_status ON operations(task_id, confirmation_scope_key, status, expires_at, created_at)");
    const taskColumns = this.db.prepare("PRAGMA table_info(task_approvals)").all().map((row) => row.name);
    if (taskColumns.length) {
      if (!taskColumns.includes("run_id")) this.db.exec("ALTER TABLE task_approvals ADD COLUMN run_id TEXT NOT NULL DEFAULT ''");
      if (!taskColumns.includes("parent_agent_id")) this.db.exec("ALTER TABLE task_approvals ADD COLUMN parent_agent_id TEXT NOT NULL DEFAULT ''");
      if (!taskColumns.includes("first_operation_id")) this.db.exec("ALTER TABLE task_approvals ADD COLUMN first_operation_id TEXT NOT NULL DEFAULT ''");
      if (!taskColumns.includes("risk_ceiling")) this.db.exec("ALTER TABLE task_approvals ADD COLUMN risk_ceiling TEXT NOT NULL DEFAULT 'L2'");
    }
  }
}

function resolveIdentity(event = {}, ctx = {}) {
  return {
    actorId: firstString(ctx.senderId, event.senderId, ctx.actorId, event.actorId),
    accountId: firstString(ctx.accountId, event.accountId),
    channelId: firstString(ctx.channelId, event.channelId),
    sessionKey: firstString(ctx.sessionKey, event.sessionKey),
    sessionId: firstString(ctx.sessionId, event.sessionId),
    agentId: firstString(ctx.agentId, event.agentId)
  };
}

function scopeMatches(op, identity) {
  const checks = [
    ["session_key", "sessionKey", true],
    ["agent_id", "agentId", true],
    ["actor_id", "actorId", false],
    ["account_id", "accountId", false],
    ["channel_id", "channelId", false],
    ["session_id", "sessionId", false]
  ];
  const limitations = [];
  for (const [opKey, idKey, required] of checks) {
    const frozen = op[opKey] || "";
    const current = identity[idKey] || "";
    if (required && frozen !== current) {
      return { ok: false, reason: `${opKey} mismatch` };
    }
    if (!required && frozen && current && frozen !== current) {
      return { ok: false, reason: `${opKey} mismatch` };
    }
    if (!required && frozen && !current) {
      limitations.push(`${opKey}:current-unavailable`);
    }
    if (!required && !frozen && current) {
      limitations.push(`${opKey}:not-frozen`);
    }
  }
  return { ok: true, limitations };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function normalizeFinalStatus(status, error) {
  if (status === "SUCCEEDED" || status === "FAILED" || status === "UNKNOWN") {
    return status;
  }
  if (error) {
    const text = String(error.message || error);
    return /timeout|aborted|unknown|network|connection/i.test(text) ? "UNKNOWN" : "FAILED";
  }
  return "SUCCEEDED";
}

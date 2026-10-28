import { definePluginEntry } from "./plugin-entry.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { OperationStore } from "./operation-store.js";
import { canonicalParams, isRecord, paramsHash } from "./canonical-json.js";
import { resolveCapability } from "./capability-resolver.js";
import { formatApprovalDescription, formatTaskApprovalDescription, generateOperationNote } from "./approval-localization.js";
import { TaskApprovalStore, resolveTaskId, resolveIdentity, buildTaskSummary, buildAllowedCapabilities } from "./task-approval.js";
import { ScopedTimeWindowStore, SCOPED_TIME_WINDOW_TTL_MS } from "./scoped-time-window.js";
import { evaluatePathPolicy } from "./path-policy.js";
import { GrantStore } from "./grant-store.js";
import { checkRegisteredSkillDedupe, releaseRegisteredSkillLock } from "./registered-skill-dedupe.js";
import { findFixedCronStart } from "./fixed-cron-start.js";
import { CronRunRegistry, findMatchingCronApprovalBypass, validateCronApprovalBypassRules } from "./cron-approval-bypass.js";

const DEFAULT_DB_PATH = "~/.openclaw/state/execution-gate.sqlite";
const CORE_SECURITY_PATH = /(?:openclaw-execution-gate|security-constitution|execution-policy|integrity|bootstrap|exec-approvals|operation-bus)/i;
const FINANCIAL = /(?:\bpayment\b|\bpay\b|\btransfer\b|create[-_]?order|final[-_]?order|\bcheckout\b|支付|转账|最终下单)/i;
const SECRET_EXPORT = /(?:token|cookie|password|private.?key|secret|bearer|authorization).*(?:send|export|upload|post|curl|wget)|(?:send|export|upload|post|curl|wget).*(?:token|cookie|password|private.?key|secret|bearer|authorization)/i;
const SCOPED_POLICY_VERSION = "scoped-time-window-v1";

export default definePluginEntry({
  id: "execution-gate",
  name: "Execution Gate",
  description: "Transparent pre-execution confirmation for native and MCP tools.",
  configSchema: { type: "object", additionalProperties: false, properties: {
    enabled: { type: "boolean" }, dbPath: { type: "string" }, operationTtlMs: { type: "integer", minimum: 1000 }, executionTimeoutMs: { type: "integer", minimum: 1000 },
    cronApprovalBypassRules: cronApprovalBypassRulesSchema()
  } },
  register(api) {
    const cfg = config(api.pluginConfig);
    const store = new OperationStore(expand(cfg.dbPath));
    store.open();
    store.markStaleExecutingUnknown({ olderThanMs: cfg.executionTimeoutMs });
    const scopedWindowStore = new ScopedTimeWindowStore(store);
    scopedWindowStore.ensureSchema();
    const taskStore = new TaskApprovalStore(store);
    taskStore.ensureSchema();
    taskStore.expireStale();
    const grantStore = new GrantStore(store);
    const cronRunRegistry = new CronRunRegistry(store, { ttlMs: cfg.operationTtlMs });
    cronRunRegistry.ensureSchema();
    const active = new Map();
    const activeRegisteredSkillScopes = new Map();
    const activeCronBypasses = new Map();
    const activeFixedCronStarts = new Map();
    let getGatewayCron = null;
    const activeToolControls = new Map();
    const grants = new Map();

    api.logger.info(`[execution-gate][runtime_policy_selected] ${JSON.stringify({ mode: "TRANSPARENT_CONFIRMATION", source: "execution-gate", bootId: cfg.bootId })}`);
    api.registerTrustedToolPolicy({
      id: "transparent-operation-bus",
      description: "Freezes the original tool call and asks Gateway for approval; it never hides native or MCP tools.",
      evaluate: async (event, ctx) => {
        if (!cfg.enabled || event?.toolName === "operation_bus") return { allow: true, reason: "transparent bus control" };
        const decision = classify(event, ctx);
        if (decision.kind === "DENY") return { allow: false, reason: decision.reason };
        if (decision.kind === "ADMIN") return { allow: false, reason: "ADMIN_PLANE_REQUIRED: Operation Bus security core may only be changed through the local admin plane." };

        const taskId = resolveTaskId(ctx, event);
        const identity = resolveIdentity(ctx, event, cfg.bootId);
        const capability = decision.capability || resolveCapability({ toolName: event.toolName, params: event.params }, ctx, {});
        const cronContext = isAutomationContext(ctx, event);
        const fixedCronRule = cfg.cronApprovalBypassRules.find((rule) => cronRunRegistry.matchesDirectGatewayCron(ctx, rule));
        const hostControl = ["CODE_MODE_CONTROL", "TOOL_CATALOG_CONTROL"].includes(capability.kind);
        if (fixedCronRule && !hostControl && decision.kind !== "FINANCIAL" && !fixedCronRule.allowTools.includes(event.toolName)) {
          return { allow: false, reason: "CRON_TOOL_OUT_OF_SCOPE: tool is outside this fixed Cron's exact allowlist" };
        }

        if (decision.kind === "NORMAL" && capability.kind === "CRON_MUTATION" && !cronContext) {
          const start = await findFixedCronStart({ rules: cfg.cronApprovalBypassRules, event, ctx, getCron: getGatewayCron });
          if (start) {
            if (store.findRecentCancellationByContext({ event, ctx, toolName: event.toolName, params: event.params, windowMs: cfg.operationTtlMs })) return { allow: false, reason: "USER_DENIED: the fixed Cron start was rejected in this task" };
            const dedupe = store.claimEffectDedupe(start.effectKey, 24 * 60 * 60_000);
            if (!dedupe.ok) return { allow: false, reason: "FIXED_CRON_START_DUPLICATE: this job was already requested in this owner turn" };
            const audit = { ruleId: start.rule.id, cronJobId: start.cronJobId, agentId: start.agentId, runId: start.runId, sessionKey: start.sessionKey, sessionId: start.sessionId, canonicalHash: start.canonicalHash, toolName: event.toolName };
            store.auditSystem("fixed_cron_start.started", audit);
            activeFixedCronStarts.set(key(event, ctx), audit);
            api.logger.info(`[execution-gate][fixed_cron_start_allow] ${JSON.stringify(audit)}`);
            return { allow: true, reason: `FIXED_CRON_START ${start.rule.id}` };
          }
        }

        // Safe L0 reads and exact registered Skill entries never create an
        // operation or approval card. The capability resolver has already
        // applied path, argv, actor, channel, and registry constraints.
        if (decision.kind === "ALLOW") {
          if (["CODE_MODE_CONTROL", "TOOL_CATALOG_CONTROL"].includes(capability.kind)) {
            const namespace = capability.kind === "CODE_MODE_CONTROL" ? "code_mode_control" : "tool_catalog_control";
            const audit = { toolName: event.toolName, controlKind: capability.kind, agentId: ctx?.agentId || "", runId: ctx?.runId || "", sessionKey: ctx?.sessionKey || "", canonicalHash: `sha256:${paramsHash(event.params || {})}` };
            store.auditSystem(`${namespace}.started`, audit);
            activeToolControls.set(controlKey(event, ctx), { namespace, audit });
          }
          if (capability.registeredSkill) {
            const dedupe = checkRegisteredSkillDedupe({ conflictScope: capability.resourceKey, capability }, Date.now());
            if (!dedupe.allow) return { allow: false, reason: dedupe.reason };
            activeRegisteredSkillScopes.set(key(event, ctx), dedupe.scope);
          }
          api.logger.info(`[execution-gate][direct_allow] ${JSON.stringify({ toolName: event.toolName, capability: capability.kind, riskLevel: capability.riskLevel })}`);
          return { allow: true, reason: decision.reason };
        }

        // Fixed Cron and child-agent runs may carry a persisted, narrowly
        // scoped Automation Grant. It is checked before interactive approval
        // so unattended jobs do not deadlock on an approval card.
        const automationGrant = decision.kind === "NORMAL" && !fixedCronRule && (!cronContext || cronRunRegistry.matchesDirectGatewayCron(ctx))
          ? grantStore.evaluateToolCall({ event, ctx, capability })
          : { action: "NO_GRANT", reason: "no trusted Cron execution binding" };
        if (automationGrant.action === "ALLOW") {
          api.logger.info(`[execution-gate][automation_grant_allow] ${JSON.stringify({ grantId: automationGrant.grantId, toolName: event.toolName, capability: capability.kind, runId: ctx?.runId || event?.runId || "" })}`);
          return { allow: true, reason: `automation grant ${automationGrant.grantId} allows ${capability.kind}` };
        }
        if (automationGrant.action === "DENY") return { allow: false, reason: automationGrant.reason };

        // This is deliberately after DENY, ADMIN, and FINANCIAL classification.
        // It only covers a run which Gateway itself registered as a direct Cron
        // launch; model parameters never participate in this decision.
        if (decision.kind === "NORMAL" && decision.scopeEligible !== false && (event.toolName !== "message" || capability.kind === "SEND_SELF_NOTIFICATION")) {
          const bypass = findMatchingCronApprovalBypass({ rules: cfg.cronApprovalBypassRules, event, ctx, registry: cronRunRegistry });
          if (bypass) {
            const dedupe = store.claimEffectDedupe(`cron-bypass:${bypass.identity.runId}:${event.toolName}:${bypass.canonicalHash}:${bypass.businessIdempotencyKey}`, 24 * 60 * 60_000);
            if (!dedupe.ok) return { allow: false, reason: `CRON_APPROVAL_BYPASS_DUPLICATE retry after ${dedupe.retryAfterMs}ms` };
            const audit = { ruleId: bypass.rule.id, agentId: bypass.identity.agentId, cronJobId: bypass.identity.cronJobId, runId: bypass.identity.runId, sessionId: ctx.sessionId || "", sessionKey: bypass.identity.sessionKey, toolName: event.toolName, canonicalHash: bypass.canonicalHash, businessIdempotencyKey: bypass.businessIdempotencyKey || null, riskClassification: capability.kind, startedAt: Date.now() };
            store.auditSystem("cron_approval_bypass.started", audit);
            activeCronBypasses.set(key(event, ctx), audit);
            api.logger.info(`[execution-gate][cron_approval_bypass_allow] ${JSON.stringify(audit)}`);
            return { allow: true, reason: `CRON_APPROVAL_BYPASS ${bypass.rule.id}` };
          }
        }

        // A five-minute decision is a narrowly bound SCOPED_TIME_WINDOW. It
        // only bypasses the card; this policy, capability/path checks and the
        // Operation Bus audit remain on every individual invocation.
        const scopedWindow = scopedWindowStore.findActive({ identity, policyVersion: cfg.policyVersion });
        if (decision.kind === "NORMAL" && !cronContext && scopedWindow) {
          api.logger.info(`[execution-gate][scoped_time_window_allow] ${JSON.stringify({ grantId: scopedWindow.grant_id, toolName: event.toolName, capability: capability.kind })}`);
          return { allow: true, reason: `SCOPED_TIME_WINDOW ${scopedWindow.grant_id} covers this normal operation` };
        }

        const recentCancellation = store.findRecentCancellationByContext({ event, ctx, toolName: event.toolName, params: event.params, windowMs: cfg.operationTtlMs });
        if (recentCancellation) {
          api.logger.info(`[execution-gate][recent_user_denial] ${JSON.stringify({ operationId: recentCancellation.operation_id, toolName: event.toolName, runId: ctx?.runId || event?.runId || "" })}`);
          return { allow: false, reason: "USER_DENIED: the same operation was rejected for this task" };
        }

        const taskScopeEligible = Boolean(taskId && decision.kind === "NORMAL" && decision.scopeEligible !== false && taskGrantRiskEligible(capability));
        if (taskScopeEligible) {
          const taskApproval = taskStore.findActiveTaskApproval({ taskId, identity });
          if (!cronContext && taskApproval && taskStore.canCover(taskApproval, { capability, toolName: event.toolName, decisionKind: decision.kind, scopeEligible: decision.scopeEligible })) {
            api.logger.info(`[execution-gate][task_scoped_auto_approved] ${JSON.stringify({ taskId, toolName: event.toolName, capability: capability.kind, approvalId: taskApproval.task_approval_id, runId: identity.runId })}`);
            return { allow: true, reason: `TASK_APPROVAL ${taskApproval.task_approval_id} covers this normal operation` };
          }
        }

        const existing = store.findPendingByContext({ event, ctx, toolName: event.toolName, params: event.params });
        if (taskScopeEligible && !existing && store.findPendingByTask({ taskId, ctx })) {
          return { allow: false, reason: "TASK_APPROVAL_PENDING: one approval is already waiting for this task" };
        }
        let displayNote = existing?.operation_id ? store.getDisplayNote(existing.operation_id) : null;
        if (!displayNote) {
          displayNote = generateOperationNote({ toolName: event.toolName, params: event.params, decision });
        }
        if (existing?.status === "EXECUTING") return { allow: false, reason: "operation is already executing" };
        if (existing?.status === "CONFIRMED") {
          const began = store.beginExecution({ operationId: existing.operation_id, event, ctx });
          if (!began.ok) return { allow: false, reason: began.reason };
          remember(active, event, ctx, existing.operation_id);
          return { allow: true, reason: "frozen original call approved" };
        }
        const created = existing || store.createOperation({ event: { ...event, params: canonicalParams(event.params) }, ctx, decision, taskId: taskId || "", ttlMs: cfg.operationTtlMs, displayNote });
        const operationId = created.operationId || created.operation_id;
        const frozenHash = created.frozenHash || created.frozen_params_hash;
        const mode = decision.kind === "FINANCIAL" ? "FINANCIAL_STEP_UP" : "CONFIRM_ONCE";

        if (mode === "CONFIRM_ONCE" && taskScopeEligible) {
          const taskSummary = buildTaskSummary({ event, decision, displayNote });
          const allowedCapabilities = ["task:normal", ...buildAllowedCapabilities({ event, decision: capability, toolName: event.toolName })];
          const taskScopeDescription = "批准后，本次任务后续的普通本地操作、工作区读写、exec、测试/构建和普通 MCP 调用（最高 L2）无需逐次确认。L3/L4 高影响操作、支付、下单、转账、秘密导出和安全核心不在此范围。";
          return {
            requireApproval: {
              pluginId: "execution-gate",
              title: "TASK_CONFIRM",
              description: formatTaskApprovalDescription({ taskSummary, allowedScopeDescription: taskScopeDescription }),
              severity: "warning",
              timeoutMs: cfg.operationTtlMs,
              timeoutBehavior: "deny",
              allowedDecisions: ["allow-once", "allow-always", "deny"],
              onResolution: async (resolution) => {
                if (resolution === "deny") {
                  const cancelled = store.cancelOperationStrict({ operationId, event, ctx, canonicalHash: `sha256:${frozenHash}` });                  api.logger.info(`[execution-gate][approval_resolution] ${JSON.stringify({ operationId, resolution, ok: cancelled.ok, result: cancelled.reason || "CANCELLED", taskId, taskApprovalId: null, scopedTimeWindowId: null, canonicalHash: `sha256:${frozenHash}` })}`);
                  return;
                }
                if (resolution !== "allow-once" && resolution !== "allow-always") return;
                const result = store.confirmOperationStrict({ operationId, event, ctx, canonicalHash: `sha256:${frozenHash}` });
                const began = result.ok ? store.beginExecution({ operationId, event, ctx }) : result;
                if (began.ok) remember(active, event, ctx, operationId);
                const taskGrant = began.ok && resolution === "allow-once"
                  ? taskStore.createTaskApproval({ taskId, identity, firstOperationId: operationId, riskCeiling: "L2", taskSummary, allowedCapabilities, allowedTools: [event.toolName] })
                  : null;
                const window = began.ok && resolution === "allow-always"
                  ? scopedWindowStore.create({ identity, policyVersion: cfg.policyVersion, ttlMs: SCOPED_TIME_WINDOW_TTL_MS })
                  : null;
                api.logger.info(`[execution-gate][approval_resolution] ${JSON.stringify({ operationId, resolution, ok: began.ok, result: began.reason || "OK", taskId, taskApprovalId: taskGrant?.approvalId || null, scopedTimeWindowId: window?.grantId || null, canonicalHash: `sha256:${frozenHash}` })}`);
              }
            }
          };
        }

        return {
          requireApproval: {
            pluginId: "execution-gate",
            title: mode === "FINANCIAL_STEP_UP" ? "FINANCIAL_STEP_UP" : "WAIT_CONFIRM",
            description: formatApprovalDescription({ event, operationId, frozenHash, mode, displayNote }),
            severity: mode === "FINANCIAL_STEP_UP" ? "critical" : "warning",
            timeoutMs: cfg.operationTtlMs,
            timeoutBehavior: "deny",            allowedDecisions: mode === "FINANCIAL_STEP_UP" ? ["allow-once", "deny"] : ["allow-once", "allow-always", "deny"],
            onResolution: async (resolution) => {
              if (resolution === "deny") {
                const cancelled = store.cancelOperationStrict({ operationId, event, ctx, canonicalHash: `sha256:${frozenHash}` });
                api.logger.info(`[execution-gate][approval_resolution] ${JSON.stringify({ operationId, resolution, ok: cancelled.ok, result: cancelled.reason || "CANCELLED", taskId: taskId || null, scopedTimeWindowId: null, canonicalHash: `sha256:${frozenHash}` })}`);
                return;
              }
              if (resolution !== "allow-once" && resolution !== "allow-always") return;
              const result = store.confirmOperationStrict({ operationId, event, ctx, canonicalHash: `sha256:${frozenHash}` });
              const began = result.ok ? store.beginExecution({ operationId, event, ctx }) : result;
              if (began.ok) remember(active, event, ctx, operationId);
              const window = began.ok && resolution === "allow-always" && mode === "CONFIRM_ONCE"
                ? scopedWindowStore.create({ identity, policyVersion: cfg.policyVersion, ttlMs: SCOPED_TIME_WINDOW_TTL_MS }) : null;
              api.logger.info(`[execution-gate][approval_resolution] ${JSON.stringify({ operationId, resolution, ok: began.ok, result: began.reason || "OK", taskId: taskId || null, scopedTimeWindowId: window?.grantId || null, canonicalHash: `sha256:${frozenHash}` })}`);
            }
          }
        };
      }
    });
    api.on("before_tool_call", async (event) => ({ params: canonicalParams(event.params) }), { priority: 100, timeoutMs: 5000 });
    api.on("before_agent_run", async (event, ctx) => {
      const cronBinding = cronRunRegistry.bindDirectGatewayCron(ctx);
      if (cronBinding.ok) api.logger.info(`[execution-gate][cron_run_registered] ${JSON.stringify({ agentId: cronBinding.agentId, cronJobId: cronBinding.cronJobId, runId: cronBinding.runId, sessionKey: cronBinding.sessionKey })}`);
      if (!cronBinding.ok) return;
      const fixedRule = cfg.cronApprovalBypassRules.find((rule) => cronRunRegistry.matchesDirectGatewayCron(ctx, rule));
      if (fixedRule) {
        api.logger.info(`[execution-gate][automation_run_binding] ${JSON.stringify({ ok: true, source: "fixed-cron-rule", ruleId: fixedRule.id, runId: ctx.runId, sessionKey: ctx.sessionKey })}`);
        return;
      }
      const binding = grantStore.bindAutomationRun({ event, ctx });
      api.logger.info(`[execution-gate][automation_run_binding] ${JSON.stringify({ ok: binding.ok, grantId: binding.grantId || null, reason: binding.reason || null, runId: ctx?.runId || event?.runId || "", sessionKey: ctx?.sessionKey || event?.sessionKey || "" })}`);
    }, { priority: 100, timeoutMs: 5000 });
    api.on("after_tool_call", async (event, ctx) => {
      const operationId = take(active, event, ctx) || store.getExecutingOperationByToolCall(event.toolName, event.toolCallId || ctx?.toolCallId)?.operation_id;
      if (operationId) store.completeAttempt({ operationId, runId: event.runId || ctx?.runId, toolCallId: event.toolCallId || ctx?.toolCallId, status: event.error ? "FAILED" : "SUCCEEDED", result: event.result, error: event.error });
      const toolControl = activeToolControls.get(controlKey(event, ctx));
      activeToolControls.delete(controlKey(event, ctx));
      if (toolControl) store.auditSystem(`${toolControl.namespace}.completed`, { ...toolControl.audit, resultStatus: toolFailed(event) ? "FAILED" : "SUCCEEDED" });
      const fixedStart = take(activeFixedCronStarts, event, ctx);
      if (fixedStart) store.auditSystem("fixed_cron_start.completed", { ...fixedStart, resultStatus: toolFailed(event) ? "FAILED" : "SUCCEEDED", endedAt: Date.now() });
      const cronBypass = take(activeCronBypasses, event, ctx);
      if (cronBypass) {
        store.auditSystem("cron_approval_bypass.completed", { ...cronBypass, endedAt: Date.now(), resultStatus: toolFailed(event) ? "FAILED" : "SUCCEEDED", exitCode: exitCodeOf(event.result), errorType: event.error ? String(event.error?.name || event.error?.code || "TOOL_ERROR") : null });
      }
      const registeredScope = take(activeRegisteredSkillScopes, event, ctx);
      if (registeredScope) releaseRegisteredSkillLock(registeredScope);
    }, { priority: 100, timeoutMs: 5000 });

    const captureGatewayCron = async (_event, ctx) => { getGatewayCron = typeof ctx?.getCron === "function" ? () => ctx.abortSignal?.aborted ? null : ctx.getCron() : null; };
    api.on("gateway_start", captureGatewayCron);
    api.on("cron_reconciled", captureGatewayCron);
    api.on("gateway_stop", async () => { getGatewayCron = null; });
    api.on("cron_changed", async (event) => {
      if (["updated", "removed"].includes(event?.action)) cronRunRegistry.invalidateJob(event.jobId);
      if ((event?.action === "added" || event?.action === "updated") && event.job) {
        if (event.job.enabled === false) grantStore.revokeGrant(`grant_${event.job.id}`);
        else grantStore.migrateEnabledCrons([event.job]);
      }
      if (event?.action === "started") {
        grantStore.bindAutomationRun({ event, ctx: { jobId: event.jobId, agentId: event.agentId, sessionKey: event.sessionKey, sessionId: event.sessionId, runId: event.runId } });
      }
    }, { priority: 100, timeoutMs: 5000 });

    api.on("agent_end", async (event, ctx) => {
      const taskId = resolveTaskId(ctx, event);
      if (taskId && taskStore.endTaskApproval(taskId)) {
        api.logger.info(`[execution-gate][task_ended] ${JSON.stringify({ taskId, runId: ctx?.runId || event?.runId || "" })}`);
      }
      cronRunRegistry.finish(ctx, event?.success === true);
      if (!isAutomationContext(ctx, event)) return;
      grantStore.finishAutomationRun({
        runId: event?.runId || ctx?.runId || "",
        sessionKey: ctx?.sessionKey || event?.sessionKey || "",
        success: event?.success === true,
        error: event?.error || ""
      });
    }, { priority: 100, timeoutMs: 5000 });

    api.on("subagent_spawned", async (event, ctx) => {
      grantStore.createChildGrantByIntersection({ event, ctx, requested: event?.requestedScope });
    }, { priority: 100, timeoutMs: 5000 });

    // This owner-only command is the explicit user revocation path. It uses
    // the same actor/channel/session tuple as the grant lookup.
    api.registerCommand?.({
      name: "revoke-5min-allow",
      description: "撤销当前会话的 5 分钟普通操作授权。",
      acceptsArgs: false,
      requireAuth: true,
      handler: async (commandCtx) => {
        const identity = resolveIdentity(commandCtx, {}, cfg.bootId);
        const changes = scopedWindowStore.revoke({ identity, policyVersion: cfg.policyVersion });
        api.logger.info(`[execution-gate][scoped_time_window_revoked] ${JSON.stringify({ changes, actorId: identity.actorId, channelId: identity.channelId, sessionId: identity.sessionId })}`);
        return { text: changes ? "已撤销当前会话的 5 分钟普通操作授权。" : "当前会话没有可撤销的 5 分钟普通操作授权。" };
      }
    });
  }
});

function classify(event, ctx) {
  const toolName = String(event?.toolName || "");
  // These discriminators are supplied by the host from tool object identity,
  // never from model arguments. The bridge's inner calls re-enter this policy
  // with their own tool metadata; no shell/script permission is inherited.
  const kinds = [event?.toolKind, ctx?.toolKind].filter((value) => value !== undefined);
  if (kinds.includes("code_mode_exec")) {
    const inputs = [event?.toolInputKind, ctx?.toolInputKind].filter((value) => value !== undefined);
    if (toolName !== "exec" || (ctx?.toolName !== undefined && ctx.toolName !== "exec") || kinds.some((value) => value !== "code_mode_exec") || !inputs.length || inputs.some((value) => value !== "javascript")) {
      return { kind: "DENY", reason: "DENY: invalid host Code Mode tool identity" };
    }
    return { kind: "ALLOW", reason: "host Code Mode JavaScript control; inner tools require policy checks", capability: { kind: "CODE_MODE_CONTROL", riskLevel: "L0", operationType: "code-mode-control" } };
  }
  // OpenClaw's catalog controls are host tools, not effect authorization.
  // tool_call dispatches only to its finalized catalog, whose actual tool
  // implementations re-enter the trusted policy with fresh identities.
  // Do not inspect args.id for permission or add controls to a Cron allowlist.
  if (["tool_search", "tool_describe", "tool_call"].includes(toolName) && ctx?.toolName === toolName) {
    return { kind: "ALLOW", reason: "host tool catalog control; dispatched tools require policy checks", capability: { kind: "TOOL_CATALOG_CONTROL", riskLevel: "L0", operationType: "tool-catalog-control" } };
  }
  const params = isRecord(event?.params) ? event.params : {};
  const serialized = JSON.stringify(params);
  if (CORE_SECURITY_PATH.test(toolName) || CORE_SECURITY_PATH.test(String(params.path || params.file_path || ""))) return { kind: "ADMIN", operationType: "security-core", riskLevel: "L4", reason: "security core change" };
  if (/\b(?:mkfs|wipefs|fdisk)\b|(?:^|\s)dd\s+.*\bof=\/dev\b|>\s*\/dev\/(?:sd|nvme|vd)/i.test(String(params.command || ""))) return { kind: "DENY", reason: "DENY: destructive root or block-device operation" };
  if (FINANCIAL.test(toolName) || FINANCIAL.test(serialized)) return protectedDecision("FINANCIAL", "financial-step-up", "financial action", toolName, params);
  if (SECRET_EXPORT.test(`${toolName} ${serialized}`) || (isOutboundTool(toolName, params) && containsSecretMaterial(serialized))) return { kind: "DENY", reason: "DENY: credential export is prohibited" };

  const pathPolicy = evaluatePathPolicy({ toolName, params, ctx });
  if (pathPolicy.action === "FORCE_PROTECTED") {
    const capability = {
      kind: "SENSITIVE_READ",
      riskLevel: "L4",
      operationType: "sensitive-read",
      toolName,
      resourceKey: `sensitive-read:${paramsHash(params)}`
    };
    return normalDecision(capability, pathPolicy.reason, params, { scopeEligible: false });
  }

  const capability = resolveCapability({ toolName, params }, ctx, {});
  if (capability.denialCode === "ADMIN_PLANE_REQUIRED") return { kind: "ADMIN", operationType: capability.operationType, riskLevel: "L4", reason: capability.execEffectReason || "security core change", capability };
  if (capability.denialCode) return { kind: "DENY", reason: `${capability.denialCode}: ${capability.execEffectReason || "tool call is outside trusted policy"}`, capability };
  if (pathPolicy.action === "ALLOW_L0" || capability.riskLevel === "L0") {
    return { kind: "ALLOW", operationType: capability.operationType || "readonly", riskLevel: "L0", reason: pathPolicy.reason || capability.execEffectReason || `${capability.kind} is a safe read`, capability };
  }
  if (capability.registeredSkill === true && (capability.riskLevel === "L0" || capability.riskLevel === "L1")) {
    return { kind: "ALLOW", operationType: capability.operationType, riskLevel: capability.riskLevel, reason: capability.execEffectReason || `registered Skill ${capability.skillId} is allowed`, capability };
  }
  return normalDecision(capability, "transparent confirmation required", params);
}
function protectedDecision(kind, operationType, reason, toolName, params) { return { kind, operationType, riskLevel: "L4", reason, toolName, conflictScope: `${operationType}:${paramsHash(params)}`, reconcileMethod: "tool-result" }; }
function normalDecision(capability, reason, params, extra = {}) { return { kind: "NORMAL", operationType: capability.operationType || "tool-call", riskLevel: capability.riskLevel || "L2", reason, conflictScope: `${capability.toolName || "tool"}:${paramsHash(params)}`, toolName: capability.toolName || "", reconcileMethod: capability.reconcileMethod || "tool-result", capability, ...extra }; }
function config(value) { const cfg = isRecord(value) ? value : {}; return { enabled: cfg.enabled !== false, dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH, operationTtlMs: Number.isInteger(cfg.operationTtlMs) ? cfg.operationTtlMs : SCOPED_TIME_WINDOW_TTL_MS, executionTimeoutMs: Number.isInteger(cfg.executionTimeoutMs) ? cfg.executionTimeoutMs : 120000, policyVersion: typeof cfg.policyVersion === "string" && cfg.policyVersion ? cfg.policyVersion : SCOPED_POLICY_VERSION, cronApprovalBypassRules: validateCronApprovalBypassRules(cfg.cronApprovalBypassRules), bootId: `${process.pid}-${Date.now()}` }; }
function expand(path) { return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path; }
// The host may remove its command/code alias after policy evaluation. Control
// audit correlation uses the immutable invocation identity, not those aliases.
function controlKey(event, ctx) { return JSON.stringify([ctx?.agentId || "", ctx?.runId || event?.runId || "", ctx?.sessionKey || "", ctx?.sessionId || "", event?.toolName || "", ctx?.toolCallId || event?.toolCallId || ""]); }
function key(event, ctx) { return `${ctx?.runId || event?.runId || ""}:${ctx?.toolCallId || event?.toolCallId || ""}:${event?.toolName || ""}:${paramsHash(event?.params || {})}`; }
function remember(map, event, ctx, operationId) { map.set(key(event, ctx), operationId); }
function take(map, event, ctx) { const value = map.get(key(event, ctx)); map.delete(key(event, ctx)); return value; }
function scopeKey(ctx = {}) { return `${ctx.senderId || ctx.actorId || ""}:${ctx.channelId || ""}:${ctx.sessionId || ctx.sessionKey || ""}:${ctx.runId || ""}`; }
function grant(grants, ctx, type, expiresAt) { grants.set(scopeKey(ctx), { type, expiresAt }); }
function hasGrant(grants, ctx) { const value = grants.get(scopeKey(ctx)); if (!value) return false; if (value.expiresAt <= Date.now()) { grants.delete(scopeKey(ctx)); return false; } return true; }
function isAutomationContext(ctx = {}, event = {}) { return Boolean(ctx.jobId || event.jobId || /:cron:[^:]+:run:/.test(String(ctx.sessionKey || event.sessionKey || ""))); }
function isOutboundTool(toolName, params) { return toolName === "sessions_send" || (toolName === "message" && /send/i.test(String(params.action || ""))) || /(?:send.*message|message.*send)/i.test(toolName); }
function containsSecretMaterial(text) { return /(?:bearer\s+\S+|sk-[a-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:token|cookie|password|authorization)\s*[:=])/i.test(text); }
function taskGrantRiskEligible(capability) { return ["L0", "L1", "L2"].includes(String(capability?.riskLevel || "")); }
function exitCodeOf(result) { return Number.isInteger(result?.exitCode) ? result.exitCode : Number.isInteger(result?.details?.exitCode) ? result.details.exitCode : Number.isInteger(result?.code) ? result.code : null; }
function toolFailed(event) { return Boolean(event?.error || event?.result?.isError || (exitCodeOf(event?.result) !== null && exitCodeOf(event?.result) !== 0) || ["error", "failed"].includes(event?.result?.details?.run?.status)); }
function cronApprovalBypassRulesSchema() { const explicitString = { type: "string", minLength: 1, not: { const: "*" } }; return { type: "array", default: [], items: { type: "object", additionalProperties: false, required: ["id", "agentId", "jobIds", "allowTools", "bypassApproval", "audit", "dedupe"], properties: { id: explicitString, agentId: explicitString, jobIds: { type: "array", minItems: 1, items: explicitString }, allowTools: { type: "array", minItems: 1, items: explicitString }, bypassApproval: { const: true }, audit: { const: true }, dedupe: { const: true } } } }; }

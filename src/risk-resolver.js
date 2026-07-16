import { canonicalParams, isRecord, sha256Hex, stableStringify } from "./canonical-json.js";
import { resolveCapability } from "./capability-resolver.js";
import { evaluatePathPolicy } from "./path-policy.js";

const READONLY_PATTERNS = [
  /^read$/i,
  /^agents_list$/i,
  /^get_goal$/i,
  /^session_status$/i,
  /^sessions_history$/i,
  /^sessions_list$/i,
  /^subagents$/i,
  /^process$/i,
  /^web_fetch$/i,
  /^web_search$/i,
  /^memory_get$/i,
  /^memory_search$/i,
  /(^|__)query/i,
  /(^|__)list/i,
  /(^|__)get/i,
  /(^|__)detail/i,
  /(^|__)search/i,
  /(^|__)status/i,
  /(^|__)preview/i
];

const PROTECTED_NAME_PATTERNS = [
  /(^|__)create-order$/i,
  /(^|__)mall-create-order/i,
  /createOrder/i,
  /pay/i,
  /payment/i,
  /qrcode/i,
  /qr-code/i,
  /payH5Url/i,
  /coupon/i,
  /auto-bind-coupons/i,
  /redeem/i,
  /^exec$/i,
  /^gateway$/i,
  /^sessions_send$/i,
  /^sessions_spawn$/i,
  /^message$/i
];

const PAYMENT_PARAM_KEYS = [
  "payH5Url",
  "payUrl",
  "paymentUrl",
  "paymentLink",
  "payLink",
  "payOrderQrCodeUrl",
  "qrCode",
  "qrCodeUrl",
  "paymentSession",
  "paySession"
];

export function normalizeToolName(toolName) {
  return String(toolName || "").trim();
}

export function sourceFromToolName(toolName) {
  const normalized = normalizeToolName(toolName);
  const marker = normalized.indexOf("__");
  if (marker < 0) {
    return { source: "openclaw", rawName: normalized };
  }
  return {
    source: normalized.slice(0, marker),
    rawName: normalized.slice(marker + 2)
  };
}

export function extractOperationId(params) {
  if (!isRecord(params)) {
    return "";
  }
  return String(params.operation_id || params.operationId || params.execution_gate_operation_id || "").trim();
}

export function resolveRisk(event, ctx = {}, config = {}) {
  const toolName = normalizeToolName(event?.toolName);
  const { source, rawName } = sourceFromToolName(toolName);
  const params = canonicalParams(event?.params);

  if (isExplicitlyDestructiveExec(toolName, params)) {
    return protectedDecision("DENY", "L4", "destructive-system", "explicitly destructive system command is denied", toolName, source, params);
  }

  if (isCommandCronMutation(toolName, params)) {
    return protectedDecision("DENY", "L4", "command-cron", "command cron is outside first-stage runner coverage", toolName, source, params);
  }

  const pathPolicy = evaluatePathPolicy({ toolName, params, ctx });
  if (pathPolicy.action === "ALLOW_L0") {
    return {
      action: "ALLOW",
      path: "L0_READONLY",
      riskLevel: "L0",
      operationType: "readonly",
      reason: pathPolicy.reason,
      toolName,
      rawName,
      source
    };
  }
  if (pathPolicy.action === "FORCE_PROTECTED") {
    return protectedDecision("PROTECTED", "L4", "sensitive-read", pathPolicy.reason, toolName, source, params);
  }

  if (toolName === "gateway" && isGatewayMutation(params)) {
    return protectedDecision("PROTECTED", "L4", "gateway-config", "gateway mutation requires confirmation", toolName, source, params);
  }

  if (isExternalMessageSend(toolName, params)) {
    const capability = resolveCapability({ toolName, params }, ctx);
    if (capability.kind === "SEND_SELF_NOTIFICATION") {
      return directDecision(capability, toolName, rawName, source);
    }
    return protectedDecision("PROTECTED", capability.riskLevel, capability.operationType, `${capability.kind} requires confirmation`, toolName, source, params);
  }

  const capability = resolveCapability({ toolName, params }, ctx);
  if (isDirectSafeCapability(capability.kind)) {
    return {
      action: "ALLOW",
      path: "L0_SAFE_EFFECT",
      riskLevel: capability.riskLevel,
      operationType: capability.operationType,
      reason: capability.execEffectReason || `${capability.kind} direct allow`,
      toolName,
      rawName,
      source,
      capability
    };
  }
  if (capability.kind !== "UNKNOWN" && capability.kind !== "READ_WORKSPACE_SAFE") {
    return {
      ...protectedDecision("PROTECTED", capability.riskLevel, capability.operationType, capability.mutationReason || `${capability.kind} requires confirmation`, toolName, source, params),
      capability
    };
  }

  if (READONLY_PATTERNS.some((pattern) => pattern.test(toolName))) {
    return {
      action: "ALLOW",
      path: "L0_READONLY",
      riskLevel: "L0",
      operationType: "readonly",
      reason: "readonly allowlist match",
      toolName,
      rawName,
      source
    };
  }

  return protectedDecision("PROTECTED", "L4", "unknown-tool", "unknown tool defaults to protected L4", toolName, source, params);
}

function isDirectSafeCapability(kind) {
  return kind === "READ_WORKSPACE_SAFE" || kind === "READ_AUTOMATION_STATE" || kind === "READ_METER" || kind === "READ_LOGS" || kind === "QUERY_STATUS" || kind === "WORKSPACE_FILE_MUTATION" || kind === "MEITUAN_QUERY_COUPON" || kind === "MEITUAN_CLAIM_COUPON" || kind === "MCDONALDS_QUERY_COUPON" || kind === "MCDONALDS_CLAIM_COUPON" || kind === "SEND_SELF_NOTIFICATION";
}

function directDecision(capability, toolName, rawName, source) {
  return { action: "ALLOW", path: "L1_DIRECT_ALLOW", riskLevel: capability.riskLevel, operationType: capability.operationType, reason: capability.mutationReason || `${capability.kind} direct allow`, toolName, rawName, source, capability };
}

function protectedDecision(action, riskLevel, operationType, reason, toolName, source, params) {
  return {
    action,
    path: "L2_L4_EXECUTION_GATE",
    riskLevel,
    operationType,
    reason,
    toolName,
    source,
    conflictScope: `${operationType}:${sha256Hex(stableStringify(params))}`,
    reconcileMethod: reconcileMethodFor(operationType)
  };
}

function reconcileMethodFor(operationType) {
  if (operationType === "order-payment-coupon") return "query-order-or-coupon-state";
  if (operationType === "message-send") return "delivery-log-or-channel-history";
  if (operationType === "exec") return "manual-state-inspection";
  if (operationType === "gateway-config") return "gateway-config-diff";
  return "manual-reconcile";
}

function isPaymentOrOrder(toolName, params, text) {
  if (PROTECTED_NAME_PATTERNS.some((pattern) => pattern.test(toolName))) {
    return true;
  }
  if (PAYMENT_PARAM_KEYS.some((key) => Object.prototype.hasOwnProperty.call(params, key))) {
    return true;
  }
  return /payH5Url|payOrderQrCodeUrl|paymentUrl|paymentLink|create[-_]?order|coupon|redeem/i.test(text);
}

function isExternalMessageSend(toolName, params) {
  if (toolName === "sessions_send" || toolName === "sessions_spawn") {
    return true;
  }
  if (toolName === "message" && /send/i.test(String(params.action || ""))) {
    return true;
  }
  return /(^|__)message.*send|send.*message/i.test(toolName);
}

function isGatewayMutation(params) {
  const action = String(params.action || params.method || "").trim();
  return /config\.(apply|patch|set)|restart|update\.run/i.test(action);
}

function isCommandCronMutation(toolName, params) {
  if (toolName !== "cron") {
    return false;
  }
  const action = String(params.action || "").trim();
  const payload = isRecord(params.payload) ? params.payload : {};
  return /^(add|update|run)$/i.test(action) && payload.kind === "command";
}

function isExplicitlyDestructiveExec(toolName, params) {
  if (toolName !== "exec") return false;
  const command = String(params.command || "").trim();
  return /(^|\s)(?:mkfs(?:\.[a-z0-9]+)?|fdisk|parted)\b/i.test(command) || /(^|\s)rm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+\/(?:\s|$|\*)/i.test(command);
}

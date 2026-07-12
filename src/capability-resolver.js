import { canonicalParams, isRecord, sha256Hex, stableStringify } from "./canonical-json.js";
import { canonicalDestinationIdentity, destinationKey } from "./destination-identity.js";
import { resolveExecEffect } from "./exec-effect-resolver.js";
import { resolveMutationEffect } from "./mutation-effect-resolver.js";
import { OWNER_TELEGRAM_ID } from "./template-config.js";

const QUERY_PATTERNS = [
  /(^|__)query/i,
  /(^|__)list/i,
  /(^|__)get/i,
  /(^|__)detail/i,
  /(^|__)search/i,
  /(^|__)status/i,
  /(^|__)available-coupons$/i,
  /query-my-account/i
];

const COUPON_PATTERNS = [
  /(^|__)auto-bind-coupons$/i,
  /coupon/i,
  /redeem/i
];

const ORDER_PATTERNS = [
  /(^|__)create-order$/i,
  /(^|__)mall-create-order/i,
  /createOrder/i
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

export function resolveCapability(event, ctx = {}) {
  const toolName = String(event?.toolName || "").trim();
  const params = canonicalParams(event?.params);
  const source = sourceFromToolName(toolName).source;
  const mutation = resolveMutationEffect({ toolName, params, ctx });
  if (mutation) {
    return capability(mutation.kind, mutation.riskLevel, toolName, source, params, {
      operationType: mutation.operationType,
      resourceKey: mutation.resourceKey,
      mutationReason: mutation.reason
    });
  }

  if (toolName === "gateway" && isGatewayMutation(params)) {
    return capability("CONFIG_MUTATION", "L4", toolName, source, params);
  }
  if (toolName === "cron" && isCronMutation(params)) {
    return capability("CRON_MUTATION", "L4", toolName, source, params);
  }
  if (toolName === "cron" && isCronRead(params)) {
    return capability("READ_AUTOMATION_STATE", "L0", toolName, source, params);
  }
  if (/^(?:automation[_-]?grants?|grant[_-]?store)$/i.test(toolName) && isAutomationStateRead(params)) {
    return capability("READ_AUTOMATION_STATE", "L0", toolName, source, params);
  }
  if (toolName === "exec") {
    return execCapability(toolName, source, params);
  }
  if (isExternalMessageSend(toolName, params)) {
    const destination = canonicalDestinationIdentity(params, ctx);
    if (!destination.ok) {
      return capability("SEND_THIRD_PARTY_MESSAGE", "L3", toolName, source, params, { destinationError: destination.reason });
    }
    const kind = isOwnerDestination(destination.identity) ? "SEND_SELF_NOTIFICATION" : "SEND_THIRD_PARTY_MESSAGE";
    return capability(kind, kind === "SEND_SELF_NOTIFICATION" ? "L1" : "L3", toolName, source, params, { destination: destination.identity, destinationKey: destinationKey(destination.identity) });
  }
  if (isMeituanPayment(toolName, params)) {
    return capability("MEITUAN_PAYMENT", "L4", toolName, source, params);
  }
  if (isMcdPayment(toolName, params)) {
    return capability("MCDONALDS_PAYMENT", "L4", toolName, source, params);
  }
  if (isPayment(params)) {
    return capability("PAYMENT", "L4", toolName, source, params);
  }
  if (isMeituanOrder(toolName)) {
    return capability("MEITUAN_ORDER", "L4", toolName, source, params);
  }
  if (isMcdOrder(toolName)) {
    return capability("MCDONALDS_ORDER", "L4", toolName, source, params);
  }
  if (ORDER_PATTERNS.some((pattern) => pattern.test(toolName))) {
    return capability("CREATE_ORDER", "L4", toolName, source, params);
  }
  if (isMeituanClaimCoupon(toolName)) {
    return capability("MEITUAN_CLAIM_COUPON", "L1", toolName, source, params);
  }
  if (isMcdClaimCoupon(toolName)) {
    return capability("MCDONALDS_CLAIM_COUPON", "L1", toolName, source, params);
  }
  if (isMeituanQuery(toolName)) {
    return capability("MEITUAN_QUERY_COUPON", "L0", toolName, source, params);
  }
  if (isMcdQuery(toolName)) {
    return capability("MCDONALDS_QUERY_COUPON", "L0", toolName, source, params);
  }
  if (COUPON_PATTERNS.some((pattern) => pattern.test(toolName))) {
    return capability("CLAIM_COUPON", "L3", toolName, source, params);
  }
  if (QUERY_PATTERNS.some((pattern) => pattern.test(toolName))) {
    return capability("QUERY_EXTERNAL", "L1", toolName, source, params);
  }
  if (toolName === "read" || toolName === "dir_list") {
    return capability("READ_WORKSPACE_SAFE", "L0", toolName, source, params);
  }
  return { kind: "UNKNOWN", toolName, source, riskLevel: "L4", operationType: "unknown-tool" };
}

export function sourceFromToolName(toolName) {
  const normalized = String(toolName || "").trim();
  const marker = normalized.indexOf("__");
  if (marker < 0) return { source: "openclaw", rawName: normalized };
  return { source: normalized.slice(0, marker), rawName: normalized.slice(marker + 2) };
}

export function capability(name, riskLevel, toolName, source, params, extra = {}) {
  return {
    kind: name,
    riskLevel,
    operationType: operationTypeFor(name),
    toolName,
    source,
    resourceKey: resourceKeyFor(name, toolName, params),
    ...extra
  };
}

function execCapability(toolName, source, params) {
  const command = String(params.command || "").trim();
  const effect = resolveExecEffect(params);
  return capability(effect.capability, effect.riskLevel, toolName, source, params, {
    operationType: effect.operationType,
    resourceKey: effect.resourceKey || `exec:${sha256Hex(stableStringify({ command }))}`,
    command,
    fixedCommand: effect.fixedCommand || "",
    commandHash: sha256Hex(stableStringify({ command })),
    scriptIdentity: effect.scriptIdentity,
    execEffectReason: effect.reason
  });
}

function operationTypeFor(name) {
  if (name === "MEITUAN_ORDER") return "meituan-order";
  if (name === "MEITUAN_PAYMENT") return "meituan-payment";
  if (name === "MEITUAN_CLAIM_COUPON") return "meituan-claim-coupon";
  if (name === "MEITUAN_QUERY_COUPON") return "meituan-query-coupon";
  if (name === "MCDONALDS_ORDER") return "mcdonalds-order";
  if (name === "MCDONALDS_PAYMENT") return "mcdonalds-payment";
  if (name === "MCDONALDS_CLAIM_COUPON") return "mcdonalds-claim-coupon";
  if (name === "MCDONALDS_QUERY_COUPON") return "mcdonalds-query-coupon";
  if (name === "CLAIM_COUPON" || name === "CREATE_ORDER" || name === "PAYMENT") return "order-payment-coupon";
  if (name === "SEND_MESSAGE" || name === "SEND_SELF_NOTIFICATION" || name === "SEND_THIRD_PARTY_MESSAGE") return "message-send";
  if (name === "EXEC") return "exec";
  if (name === "ARBITRARY_EXEC") return "exec";
  if (name === "QUERY_STATUS") return "query-status";
  if (name === "READ_METER") return "readonly";
  if (name === "READ_LOGS") return "readonly";
  if (name === "WRITE_OWN_TASK_STATE") return "write-own-task-state";
  if (name === "WRITE_OWN_MEMORY_STATE") return "write-own-memory-state";
  if (name === "DELETE") return "delete";
  if (name === "CONFIG_MUTATION") return "gateway-config";
  if (name === "WORKSPACE_FILE_MUTATION") return "workspace-file-mutation";
  if (name === "SECURITY_POLICY_MUTATION") return "security-policy-mutation";
  if (name === "SECURITY_COMPONENT_MUTATION") return "security-component-mutation";
  if (name === "UNKNOWN_MUTATION") return "unknown-mutation";
  if (name === "CRON_MUTATION") return "cron-mutation";
  if (name === "READ_WORKSPACE_SAFE") return "readonly";
  if (name === "READ_AUTOMATION_STATE") return "readonly";
  return name.toLowerCase();
}

function isOwnerDestination(identity) {
  return identity.channel === "telegram" && identity.recipient_type === "user" && identity.recipient_id === OWNER_TELEGRAM_ID;
}

function isMeituanTool(toolName) {
  return /(?:^|__)meituan(?:__|[-_])/i.test(toolName) || /^meituan/i.test(toolName);
}

function isMeituanQuery(toolName) {
  return isMeituanTool(toolName) && /available-coupons|query-(?:my-|store-)?coupons|query-order|query-my-account/i.test(toolName);
}

function isMeituanClaimCoupon(toolName) {
  return isMeituanTool(toolName) && /auto-bind-coupons|claim|redeem/i.test(toolName);
}

function isMeituanOrder(toolName) {
  return isMeituanTool(toolName) && /create-order|mall-create-order/i.test(toolName);
}

function isMeituanPayment(toolName, params) {
  return isMeituanTool(toolName) && (isPayment(params) || /payment|pay/i.test(toolName));
}

function isMcdTool(toolName) {
  return /^mcd-mcp__/i.test(toolName);
}

function isMcdQuery(toolName) {
  return isMcdTool(toolName) && /available-coupons|query-(?:my-|store-)?coupons|query-order|query-my-account/i.test(toolName);
}

function isMcdClaimCoupon(toolName) {
  return isMcdTool(toolName) && /auto-bind-coupons|claim|redeem/i.test(toolName);
}

function isMcdOrder(toolName) {
  return isMcdTool(toolName) && /create-order|mall-create-order/i.test(toolName);
}

function isMcdPayment(toolName, params) {
  return isMcdTool(toolName) && (isPayment(params) || /payment|pay/i.test(toolName));
}

function resourceKeyFor(name, toolName, params) {
  if (name === "EXEC") return `exec:${sha256Hex(stableStringify({ command: params.command || "" }))}`;
  return `${toolName}:${sha256Hex(stableStringify(params || {}))}`;
}

function isPayment(params) {
  if (!isRecord(params)) return false;
  return PAYMENT_PARAM_KEYS.some((key) => Object.prototype.hasOwnProperty.call(params, key));
}

function isExternalMessageSend(toolName, params) {
  if (toolName === "sessions_send" || toolName === "sessions_spawn") return true;
  if (toolName === "message" && /send/i.test(String(params.action || ""))) return true;
  return /(^|__)message.*send|send.*message/i.test(toolName);
}

function isGatewayMutation(params) {
  const action = String(params.action || params.method || "").trim();
  return /config\.(apply|patch|set)|restart|update\.run/i.test(action);
}

function isCronMutation(params) {
  const action = String(params.action || "").trim();
  return /^(add|update|run|enable|disable|remove|delete)$/i.test(action);
}

function isCronRead(params) {
  const action = String(params.action || "").trim();
  return /^(list|get|status)$/i.test(action);
}

function isAutomationStateRead(params) {
  const action = String(params.action || "list").trim();
  return /^(list|get|status|runs|history)$/i.test(action);
}


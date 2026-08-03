// User-facing approval copy only. Protocol values, IDs, hashes and commands stay in audit records.

// ---------- task-scoped approval card ----------

export function formatTaskApprovalDescription({ taskSummary, allowedScopeDescription, ttlMs = 900_000 }) {
  const minutes = Math.round(ttlMs / 60_000);
  return `🛡️ 需要确认\n\n任务：\n${taskSummary}\n\n将允许：\n${allowedScopeDescription}\n\n有效期：\n仅限当前任务，任务结束后自动失效。`;
}

export function formatApprovalDescription({ event, operationId, frozenHash, mode, displayNote }) {
  // IDs and hashes remain frozen in the operation store and audit log.  The
  // user-facing card only needs a plain-language consequence summary.
  const toolName = String(event?.toolName || "");
  const note = typeof displayNote === "string" && displayNote.trim()
    ? displayNote.trim()
    : directToolNote(toolName, {}) || `将使用 ${friendlyToolName(toolName)} 完成当前任务。`;
  if (mode === "FINANCIAL_STEP_UP") {
    return `操作备注：\n${note}\n\n此操作可能产生真实费用，只允许本次确认。`;
  }
  return `操作备注：\n${note}`;
}

export function tenMinuteGrantNotice() {
  return "批准后，未来 5 分钟内的普通操作无需逐次确认。\n\n授权范围：exec、read、write、edit、web_fetch、普通浏览器操作、普通 MCP 调用、测试和构建、普通业务配置，以及 Skill/MCP 安装的检查和准备阶段。\n有效期：300 秒。\n\n真实支付、最终下单、转账、秘密导出、安全核心、关闭审计、系统破坏和块设备写入不受此授权覆盖。";
}

export function sessionGrantNotice() {
  return tenMinuteGrantNotice();
}

export const approvalStatusZh = Object.freeze({
  ALREADY_CONSUMED: "该审批已使用，不能重复执行。",
  EXPIRED: "该审批已过期，请重新发起操作。",
  DENIED: "该操作已被拒绝。",
  ACTOR_SCOPE_MISMATCH: "当前操作者、渠道或会话与原审批不一致，无法批准。",
  HASH_MISMATCH: "冻结调用的完整性校验失败，操作已拒绝。",
  RESTORE_FAILED: "无法恢复原始冻结调用，操作未执行。",
  SUCCEEDED: "操作已批准并执行完成。",
  FAILED: "操作已批准，但执行失败。",
  TASK_APPROVAL_COVERED: "当前操作已被任务级授权覆盖，无需重复审批。",
  TASK_APPROVAL_EXPIRED: "任务级授权已失效，请重新发起任务。",
});

// ---------- operation note generation ----------

const SECRET_KEY_PATTERN = /token|password|secret|key|auth|cookie|credential|api[_-]?key/i;

const FAKE_DISPLAY_FIELDS = new Set([
  "note", "operationNote", "displaySummary", "description",
  "riskText", "scopeText", "displayText", "Note"
]);

export function generateOperationNote({ toolName, params, decision }) {
  const opType = decision?.operationType || "unknown-tool";
  const safeParams = sanitizeParams(params);

  switch (opType) {
    case "exec":
    case "trusted-project-command":
    case "trusted-workspace-script":
    case "trusted-exec-plan":
      return execNote(safeParams);
    case "cron-mutation":
      return cronNote(safeParams);
    case "workspace-file-mutation":
    case "write-own-task-state":
    case "write-own-memory-state":
      return "将修改工作区中的文件。";
    case "delete":
      return "将删除指定的文件或目录，删除后可能无法恢复。";
    case "readonly":
    case "READ_WORKSPACE_SAFE":
    case "READ_AUTOMATION_STATE":
    case "query-status":
    case "READ_LOGS":
    case "READ_METER":
    case "NUMBER_QUERY":
      return "只读取信息，不修改任何文件或配置。";
    // ---- MCP ----
    case "meituan-order":
    case "mcdonalds-order":
    case "CREATE_ORDER":
      return `将调用 ${mcpServiceName(toolName)} 创建订单。`;
    case "meituan-payment":
    case "mcdonalds-payment":
    case "PAYMENT":
      return `将调用 ${mcpServiceName(toolName)} 执行支付操作，可能产生真实费用。`;
    case "meituan-claim-coupon":
    case "mcdonalds-claim-coupon":
    case "CLAIM_COUPON":
      return `将调用 ${mcpServiceName(toolName)} 领取优惠券。`;
    case "meituan-query-coupon":
    case "mcdonalds-query-coupon":
    case "QUERY_EXTERNAL":
      return `将调用 ${mcpServiceName(toolName)} 查询信息，只读取数据。`;
    case "order-payment-coupon":
      return `将调用 ${mcpServiceName(toolName)} 执行订单或支付相关操作。`;
    // ---- messages ----
    case "message-send":
    case "SEND_SELF_NOTIFICATION":
      return "将向自己发送通知消息。";
    case "SEND_THIRD_PARTY_MESSAGE":
      return "将向外部发送消息或通知。";
    // ---- config ----
    case "gateway-config":
      return "将修改 Gateway 配置，可能重新加载服务。";
    case "security-policy-mutation":
    case "security-component-mutation":
      return "将修改安全策略配置。";
    // ---- auth ----
    case "number-auth-start":
      return "将发起号码验证流程。";
    case "number-auth-submit":
      return "将提交号码验证。";
    // ---- fallback ----
    default: {
      const direct = directToolNote(toolName, safeParams);
      if (direct) return direct;
      if (isMcpTool(toolName)) return `将调用外部服务 ${mcpServiceName(toolName)}。`;
      return `将使用 ${friendlyToolName(toolName)} 完成当前任务。`;
    }
  }
}


function directToolNote(toolName, params = {}) {
  const tool = String(toolName || "");
  const action = String(params?.action || params?.method || "").toLowerCase();
  if (tool === "nodes") {
    if (/^(status|list|get|describe)$/.test(action)) return "将查看已连接设备的状态，只读取信息。";
    return "将对已连接设备执行一项操作。";
  }
  if (tool === "session_status") return "将查看当前会话状态，只读取信息。";
  if (tool === "sessions_list") return "将列出最近会话，只读取信息。";
  if (tool === "sessions_search") return "将在会话记录中搜索相关内容，只读取信息。";
  if (tool === "subagents") {
    if (!action || action === "list") return "将查看子 Agent 的运行状态，只读取信息。";
    return "将管理当前任务中的子 Agent。";
  }
  if (tool === "web_search") return "将在网络上搜索公开信息，只读取结果。";
  if (tool === "web_fetch") return "将读取指定网页的内容。";
  if (tool === "browser") return "将使用浏览器完成当前网页操作。";
  if (tool === "read" || tool === "dir_list") return "将读取文件或目录内容，不会修改数据。";
  if (tool === "write") return "将写入指定文件。";
  if (tool === "edit" || tool === "apply_patch") return "将修改指定文件。";
  if (tool === "gateway") return "将执行 Gateway 相关操作。";
  if (tool === "openclaw") return "将执行 OpenClaw 相关操作。";
  return "";
}

function friendlyToolName(toolName) {
  const value = String(toolName || "").trim();
  const map = {
    nodes: "设备工具",
    subagents: "子 Agent 工具",
    session_status: "会话状态工具",
    sessions_list: "会话列表工具",
    sessions_search: "会话搜索工具",
    gateway: "Gateway 工具",
    openclaw: "OpenClaw 工具",
  };
  return map[value] || (value ? `“${value}”工具` : "当前工具");
}

// Build a human-readable scope description for the task approval card
export function buildScopeDescription({ displayNote, decision, toolName }) {
  const source = mcpSource(toolName);
  const serviceNote = source ? friendlyServiceName(source) : "";

  // If we have a display note, use it to build the scope
  if (displayNote && typeof displayNote === "string") {
    // For read queries, state it's read-only
    if (isReadCapability(decision)) {
      if (serviceNote) return `本任务调用${serviceNote}进行只读查询。`;
      return "本任务执行只读操作。";
    }
    return displayNote;
  }

  // Fallback scope descriptions
  if (isReadCapability(decision)) {
    if (serviceNote) return `本任务调用${serviceNote}进行只读查询。`;
    return "执行完成该任务所需的普通只读操作。";
  }

  return "执行完成该任务所需的普通工具操作。";
}

// ---- helpers ----

function execNote(params) {
  const command = String(params?.command || "");
  if (!command) return "将在服务器上执行一项操作。";
  const parts = command.trim().split(/\s+/);
  const exe = parts[0] || "";
  const rest = parts.slice(1).join(" ");
  if (/^(npm|pnpm|yarn)$/.test(exe) && rest.includes("test")) return "将运行项目测试，检查代码修改是否正常。";
  if (/^(npm|pnpm|yarn)$/.test(exe) && /install|add/i.test(rest)) return "将安装项目依赖。";
  if (/^(npm|pnpm|yarn)$/.test(exe) && rest.includes("run")) return "将运行 npm 脚本。";
  if (/^(npm|pnpm|yarn)$/.test(exe)) return "将执行包管理器操作。";
  if (exe === "git" && /status/i.test(rest)) return "将查看 Git 仓库状态，只读取信息。";
  if (exe === "git" && /diff/i.test(rest)) return "将查看代码修改差异，只读取信息。";
  if (exe === "git" && /log/i.test(rest)) return "将查看提交历史，只读取信息。";
  if (exe === "git") return "将执行 Git 操作。";
  if (exe === "node" || exe === "nodejs") return "将运行 Node.js 脚本。";
  if (exe === "python" || exe === "python3") return "将运行 Python 脚本。";
  if (exe === "bash" || exe === "sh") return "将执行 Shell 脚本。";
  if (/^(ls|dir|cat|head|tail|grep|find|sort|uniq|wc|cut|tr|readlink|stat|pwd)$/.test(exe)) return "将查看文件或目录内容，只读取信息。";
  if (/^(date|whoami|hostname|ps|pgrep|df|du|free|uptime)$/.test(exe)) return "将查看系统状态信息，只读取信息。";
  if (exe === "mkdir") return "将创建新目录。";
  if (exe === "touch") return "将创建新文件或修改文件时间戳。";
  if (/^(cp|mv)$/.test(exe)) return "将复制或移动文件。";
  if (exe === "rm") return "将删除文件或目录，删除后可能无法恢复。";
  if (/^(echo|printf)$/.test(exe)) return "将输出指定内容。";
  if (/^(curl|wget)$/.test(exe)) return "将访问外部网络服务获取数据。";
  if (exe === "docker") return "将执行 Docker 容器操作。";
  if (exe === "ssh") return "将连接到远程服务器。";
  if (exe === "ping") return "将测试网络连通性。";
  if (exe === "openclaw") return "将执行 OpenClaw 管理操作。";
  return `将在服务器上执行 ${exe} 操作。`;
}

function cronNote(params) {
  const action = String(params?.action || "");
  const schedule = String(params?.schedule || "");
  const cronDesc = schedule ? translateCronBrief(schedule) : "";

  const actionMap = {
    "create": "创建一个自动任务",
    "add": "创建一个自动任务",
    "update": "修改一个自动任务",
    "enable": "启用一个自动任务",
    "disable": "停用一个自动任务",
    "delete": "删除一个自动任务",
    "remove": "删除一个自动任务",
    "run": "立即运行一个自动任务",
  };
  const actionDesc = actionMap[String(action).toLowerCase()] || "修改自动任务配置";

  if (cronDesc) {
    return `${actionDesc}，${cronDesc}自动运行。`;
  }
  return `${actionDesc}，将按照设定的时间自动运行。批准后该任务会重复执行，之后可以停用或删除。`;
}

function translateCronBrief(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length < 5) return "";
  const [min, hour, dom, month, dow] = parts;
  if (allStar(min, hour, dom, month, dow)) return "每分钟";
  if (step(min) && allStar("*", hour, dom, month, dow)) return `每 ${stepVal(min)} 分钟`;
  if (min === "0" && step(hour) && allStar("*", "*", dom, month, dow)) return `每 ${stepVal(hour)} 小时`;
  if (isNum(min) && isNum(hour) && allStar("*", dom, month, dow)) return `每天 ${pad(hour)}:${pad(min)}`;
  if (isNum(min) && isNum(hour) && dom === "*" && month === "*" && isNum(dow)) {
    const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
    return `每周${dayNames[parseInt(dow)] || dow} ${pad(hour)}:${pad(min)}`;
  }
  if (isNum(min) && isNum(hour) && dom === "*" && month === "*" && dow === "1-5") return `工作日 ${pad(hour)}:${pad(min)}`;
  if (isNum(min) && isNum(hour) && isNum(dom) && month === "*" && dow === "*") return `每月 ${parseInt(dom)} 日 ${pad(hour)}:${pad(min)}`;
  return "";
}

function allStar(...args) { return args.every((a) => a === "*"); }
function step(s) { return /^\*\/\d+$/.test(s); }
function stepVal(s) { return parseInt(s.replace("*/", "")); }
function isNum(s) { return /^\d+$/.test(s); }
function pad(n) { const v = parseInt(n); return isNaN(v) ? n : String(v).padStart(2, "0"); }

function mcpServiceName(toolName) {
  const t = String(toolName || "");
  const idx = t.indexOf("__");
  if (idx < 0) return t;
  const source = t.slice(0, idx);
  return friendlyServiceName(source);
}

function friendlyServiceName(source) {
  const nameMap = { "mcd-mcp": "麦当劳", "meituan": "美团", "shop_mcp": "商城" };
  return nameMap[source] || `${source} MCP`;
}

function mcpSource(toolName) {
  const t = String(toolName || "");
  const idx = t.indexOf("__");
  return idx > 0 ? t.slice(0, idx) : "";
}

function isMcpTool(toolName) {
  return String(toolName || "").includes("__");
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

function sanitizeParams(params) {
  if (!params || typeof params !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (FAKE_DISPLAY_FIELDS.has(k)) continue;
    if (SECRET_KEY_PATTERN.test(k)) continue;
    if (typeof v === "string" && /\/\/[^:@]+:[^@]+@/.test(v)) continue;
    out[k] = v;
  }
  return out;
}

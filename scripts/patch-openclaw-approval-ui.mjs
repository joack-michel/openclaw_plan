#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const launcher = process.env.OPENCLAW_LAUNCHER || "";
if (!launcher) throw new Error("OPENCLAW_LAUNCHER is required");
const launcherText = readFileSync(launcher, "utf8");
const match = launcherText.match(/"\$basedir\/([^"\n]*\/node_modules\/openclaw\/openclaw\.mjs)"/);
if (!match) throw new Error(`cannot resolve OpenClaw package from ${launcher}`);
const packageRoot = dirname(resolve(dirname(launcher), match[1]));
const dist = join(packageRoot, "dist");
if (!existsSync(dist)) throw new Error(`OpenClaw dist not found: ${dist}`);
const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
const openclawHome = resolve(process.env.OPENCLAW_HOME || join(homedir(), ".openclaw"));
const backupDir = join(openclawHome, "state", "openclaw-runtime-patches", version);
mkdirSync(backupDir, { recursive: true });

const targets = [
  {
    prefix: "exec-approval-reply-",
    replacements: [
      ['label: "Allow Once"', 'label: "仅允许一次"'],
      ['label: "Allow Always"', 'label: "允许 5 分钟"'],
      ['label: "Deny"', 'label: "拒绝"'],
      ['return "Approval required. I sent approval DMs to the approvers for this account.";', 'return "需要审批。审批请求已发送给当前账号的审批人。";'],
      ['lines.push("Approval required.");', 'lines.push("需要审批。");'],
      ['lines.push("Run:");', 'lines.push("执行：");'],
      ['lines.push("Pending command:");', 'lines.push("待执行命令：");'],
      ['lines.push("Other options:");', 'lines.push("其他选项：");'],
      ['info.push(`Expires in: ${formatExecApprovalExpiresIn(params.expiresAtMs, params.nowMs ?? Date.now())}`);', 'info.push(`有效期：${formatExecApprovalExpiresIn(params.expiresAtMs, params.nowMs ?? Date.now())}`);'],
      ['info.push(`Full id: \\`${params.approvalId}\\``);', 'info.push(`审批编号：\\`${params.approvalId}\\``);'],
    ]
  },
  {
    prefix: "approval-reaction-runtime-",
    replacements: [
      ['label: "Allow Once"', 'label: "仅允许一次"'],
      ['label: "Allow Always"', 'label: "允许 5 分钟"'],
      ['label: "Deny"', 'label: "拒绝"'],
      ['return `React with:\\n\\n${bindings.map((binding) => `${binding.emoji} ${binding.label}`).join("\\n")}`;', 'return `可使用表情确认：\\n\\n${bindings.map((binding) => `${binding.emoji} ${binding.label}`).join("\\n")}`;'],
      ['const header = ["Plugin approval required", `ID: ${view.approvalId}`];', 'const header = ["🛡️ 需要审批"];'],
      ['const details = [`Title: ${view.title}`];', 'const details = [];'],
      ['if (view.description) details.push(`Description: ${view.description}`);', 'if (view.description) details.push(view.description);'],
      ['if (view.toolName) details.push(`Tool: ${view.toolName}`);', 'if (view.toolName) details.push(`工具：${view.toolName}`);'],
      ['if (view.pluginId) details.push(`Plugin: ${view.pluginId}`);', 'if (view.pluginId) details.push(`插件：${view.pluginId}`);'],
      ['if (view.agentId) details.push(`Agent: ${view.agentId}`);', 'if (view.agentId) details.push(`智能体：${view.agentId}`);'],
      ['details.push(`Expires in: ${formatExecApprovalExpiresIn(view.expiresAtMs, params.nowMs)}`);', 'details.push(`有效期：${formatExecApprovalExpiresIn(view.expiresAtMs, params.nowMs)}`);'],
      ['details.push(`Full id: \\`${view.approvalId}\\``);', ''],
    ]
  },
  {
    prefix: "plugin-approvals-",
    replacements: [
      ['if (decision === "allow-once") return "allowed once";', 'if (decision === "allow-once") return "仅允许一次";'],
      ['if (decision === "allow-always") return "allowed always";', 'if (decision === "allow-always") return "允许 5 分钟";'],
      ['return "denied";', 'return "已拒绝";'],
      ['lines.push(`${icon} Plugin approval required`);', 'lines.push(`${icon} 需要审批`);'],
      ['lines.push(`Title: ${request.request.title}`);', ''],
      ['lines.push(`Description: ${request.request.description}`);', 'lines.push(request.request.description);'],
      ['if (request.request.toolName) lines.push(`Tool: ${request.request.toolName}`);', 'if (request.request.toolName) lines.push(`工具：${request.request.toolName}`);'],
      ['if (request.request.pluginId) lines.push(`Plugin: ${request.request.pluginId}`);', 'if (request.request.pluginId) lines.push(`插件：${request.request.pluginId}`);'],
      ['if (request.request.agentId) lines.push(`Agent: ${request.request.agentId}`);', 'if (request.request.agentId) lines.push(`智能体：${request.request.agentId}`);'],
      ['lines.push(`ID: ${request.id}`);', ''],
      ['lines.push(`Expires in: ${expiresIn}s`);', 'lines.push(`有效期：${expiresIn} 秒`);'],
      ['lines.push(`Reply with: /approve ${request.id} ${resolvePluginApprovalRequestAllowedDecisions(request.request).join("|")}`);', ''],
      ['return `${`✅ Plugin approval ${approvalDecisionLabel(resolved.decision)}.`}${resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : ""} ID: ${resolved.id}`;', 'return `✅ 审批已处理：${approvalDecisionLabel(resolved.decision)}`;'],
      ['return `⏱️ Plugin approval expired. ID: ${request.id}`;', 'return "⏱️ 审批已过期。";'],
    ]
  },
  {
    prefix: "approval-terminal-",
    replacements: [
      ['if (decision === "allow-always") return "Allowed always";', 'if (decision === "allow-always") return "允许 5 分钟";'],
      ['if (decision === "allow-once") return "Allowed once";', 'if (decision === "allow-once") return "仅允许一次";'],
      ['return decision === "deny" ? "Denied" : "Resolved";', 'return decision === "deny" ? "已拒绝" : "已处理";'],
      ['return approval.status === "expired" ? "Expired" : "Cancelled";', 'return approval.status === "expired" ? "已过期" : "已取消";'],
      ['const lines = [\n\t\tparams.result.applied ? "✅ Approval resolved here" : "ℹ️ Approval already resolved",\n\t\t`Canonical result: ${formatCanonicalResult(approval)}`,\n\t\t`ID: ${truncateApprovalId(approvalId)}`\n\t];\n\tif (approval.presentation) appendCanonicalSubject(lines, approval.presentation);', 'const lines = [params.result.applied ? `✅ 审批已处理：${formatCanonicalResult(approval)}` : `ℹ️ 审批已处理：${formatCanonicalResult(approval)}`];'],
      ['const lines = params.outcome === "resolved-here" ? ["✅ Approval resolved here", `Result: ${formatApprovalDecision(params.decision)}`] : params.outcome === "no-longer-pending" ? ["ℹ️ Approval no longer pending", "It was already resolved or expired; the canonical decision is unavailable here."] : ["ℹ️ Approval is no longer actionable from this button", "It may have been resolved, expired, or require a different authorized approval surface."];\n\tlines.push(`ID: ${truncateApprovalId(params.approvalId)}`);', 'const lines = params.outcome === "resolved-here" ? [`✅ 审批已处理：${formatApprovalDecision(params.decision)}`] : params.outcome === "no-longer-pending" ? ["ℹ️ 该审批已处理或已过期。"] : ["ℹ️ 此按钮已失效，请查看最新审批状态。"];'],
      ['return "ℹ️ Approval action unavailable\\nThis button is invalid or no longer actionable.";', 'return "ℹ️ 审批按钮已失效。";'],
      ['const lines = [`✅ ${view.approvalKind === "exec" ? "Exec" : "Plugin"} approval resolved`, `Canonical result: ${formatApprovalDecision(view.decision)}`];\n\tif (view.resolvedBy?.trim()) lines.push(`Resolved by: ${formatResolvedBy(view.resolvedBy)}`);\n\tlines.push(`ID: ${truncateApprovalId(view.approvalId)}`);\n\tappendViewSubject(lines, view);', 'const lines = [`✅ 审批已处理：${formatApprovalDecision(view.decision)}`];'],
      ['const lines = [\n\t\t`⏱️ ${view.approvalKind === "exec" ? "Exec" : "Plugin"} approval expired`,\n\t\t"Canonical result: Expired",\n\t\t`ID: ${truncateApprovalId(view.approvalId)}`\n\t];\n\tappendViewSubject(lines, view);', 'const lines = ["⏱️ 审批已过期。"];'],
    ]
  }
];

let changedFiles = 0;
for (const target of targets) {
  const files = readdirSync(dist).filter((name) => name.startsWith(target.prefix) && name.endsWith(".js"));
  if (files.length === 0) throw new Error(`expected at least one ${target.prefix}*.js`);
  let matchedFamily = false;
  for (const name of files) {
    const file = join(dist, name);
    let text = readFileSync(file, "utf8");
    let changed = false;
    for (const [from, to] of target.replacements) {
      if (text.includes(from)) {
        text = text.replace(from, to);
        changed = true;
      }
    }
    const alreadyLocalized = /需要审批|仅允许一次|审批已处理/.test(text);
    if (!changed && !alreadyLocalized) continue;
    matchedFamily = true;
    if (!changed) {
      console.log(`already localized: ${basename(file)}`);
      continue;
    }
    const backup = join(backupDir, basename(file));
    if (!existsSync(backup)) cpSync(file, backup);
    writeFileSync(file, text);
    changedFiles += 1;
    console.log(`patched: ${basename(file)}`);
  }
  if (!matchedFamily) throw new Error(`no expected approval strings found in ${target.prefix}*.js`);
}

const uiAssets = join(dist, "control-ui", "assets");
const approvalUiReplacements = [
  ['allowOnce:`Allow once`', 'allowOnce:`仅允许一次`'],
  ['alwaysAllow:`Always allow`', 'alwaysAllow:`允许 5 分钟`'],
  ['allowAlwaysUnavailable:`Allow Always is unavailable for this command.`', 'allowAlwaysUnavailable:`此操作不支持 5 分钟授权。`'],
  ['deny:`Deny`', 'deny:`拒绝`'],
  ['allowOnce:`允许一次`', 'allowOnce:`仅允许一次`'],
  ['alwaysAllow:`始终允许`', 'alwaysAllow:`允许 5 分钟`'],
  ['allowAlwaysUnavailable:`“始终允许”不可用于此命令。`', 'allowAlwaysUnavailable:`此操作不支持 5 分钟授权。`'],
  ['eyebrow:`Operator approval`', 'eyebrow:`操作审批`'],
  ['loadingTitle:`Loading approval`', 'loadingTitle:`正在加载审批`'],
  ['loadingDescription:`Checking the current approval state with the Gateway.`', 'loadingDescription:`正在向 Gateway 查询当前审批状态。`'],
  ['unavailableTitle:`Approval unavailable`', 'unavailableTitle:`审批不可用`'],
  ['unavailableDescription:`This approval could not be found or this device is not authorized to review it.`', 'unavailableDescription:`找不到该审批，或此设备没有审批权限。`'],
  ['connectionErrorTitle:`Connection interrupted`', 'connectionErrorTitle:`连接已中断`'],
  ['connectionErrorDescription:`OpenClaw cannot confirm or record a decision while disconnected. Reconnect to check the current status.`', 'connectionErrorDescription:`断开连接时无法提交审批结果。重新连接后可查看当前状态。`'],
  ['retry:`Retry`', 'retry:`重试`'],
  ['execTitle:`Command approval`', 'execTitle:`命令审批`'],
  ['pending:`Waiting for your decision`', 'pending:`等待你的决定`'],
  ['pendingDescription:`Review the request carefully. The first answer from any surface wins.`', 'pendingDescription:`请确认操作备注。App、Telegram 等任一入口最先提交的结果生效。`'],
  ['approvedHere:`Approved here`', 'approvedHere:`已在此允许`'],
  ['deniedHere:`Denied here`', 'deniedHere:`已在此拒绝`'],
  ['resolvedElsewhere:`Resolved elsewhere`', 'resolvedElsewhere:`已在其他入口处理`'],
  ['resolvedElsewhereDescription:`Another surface or an earlier attempt recorded the decision first.`', 'resolvedElsewhereDescription:`其他入口或更早的操作已先提交结果。`'],
  ['approved:`Approved`', 'approved:`已允许`'],
  ['denied:`Denied`', 'denied:`已拒绝`'],
  ['cancelled:`Cancelled`', 'cancelled:`已取消`'],
  ['allowedOnceDescription:`The operation was approved for this request only.`', 'allowedOnceDescription:`仅允许执行本次操作。`'],
  ['allowedAlwaysDescription:`The operation was approved with the always-allow decision.`', 'allowedAlwaysDescription:`已授予 5 分钟范围授权。`'],
  ['deniedDescription:`The operation was denied and will not continue.`', 'deniedDescription:`操作已拒绝，不会继续执行。`'],
  ['expiredDescription:`No decision arrived before the deadline, so the operation was denied.`', 'expiredDescription:`有效期内未收到决定，操作已拒绝。`'],
  ['cancelledDescription:`The requesting run ended before a decision could be used.`', 'cancelledDescription:`请求该操作的任务已结束。`'],
  ['summaryLabel:`Summary`', 'summaryLabel:`操作备注`'],
  ['requestLabel:`Request details`', 'requestLabel:`请求详情`'],
  ['toolLabel:`Tool`', 'toolLabel:`工具`'],
  ['expiresLabel:`Expires`', 'expiresLabel:`有效期`'],
  ['resolvedLabel:`Resolved`', 'resolvedLabel:`处理结果`'],
  ['actionsLabel:`Approval decisions`', 'actionsLabel:`审批选项`'],
  ['resolvingDecision:`Recording {decision}…`', 'resolvingDecision:`正在提交：{decision}…`'],
  ['safeToClose:`The decision is recorded. You can close this page.`', 'safeToClose:`审批结果已记录，可以关闭此页面。`'],
  ['openControlUi:`Open Control UI`', 'openControlUi:`打开控制界面`'],
];
if (existsSync(uiAssets)) {
  const uiFiles = readdirSync(uiAssets).filter((name) => (name.startsWith("zh-CN-") || name.startsWith("control-ui-core-")) && name.endsWith(".js"));
  let matchedUi = false;
  for (const name of uiFiles) {
    const file = join(uiAssets, name);
    let text = readFileSync(file, "utf8");
    if (!text.includes("execApproval:") && !text.includes("approvalPage:")) continue;
    let changed = false;
    for (const [from, to] of approvalUiReplacements) {
      if (text.includes(from)) {
        text = text.replaceAll(from, to);
        changed = true;
      }
    }
    matchedUi = true;
    if (!changed) {
      console.log(`already localized: control-ui/assets/${name}`);
      continue;
    }
    const backup = join(backupDir, name);
    if (!existsSync(backup)) cpSync(file, backup);
    writeFileSync(file, text);
    changedFiles += 1;
    console.log(`patched: control-ui/assets/${name}`);
  }
  if (!matchedUi) throw new Error("OpenClaw approval Control UI bundle not found");
}

const forbiddenRuntimeStrings = [
  'label: "Allow Once"',
  'label: "Allow Always"',
  'label: "Deny"',
  'Plugin approval resolved',
  'Canonical result:',
  'Resolved by:',
];
for (const target of targets) {
  for (const name of readdirSync(dist).filter((entry) => entry.startsWith(target.prefix) && entry.endsWith(".js"))) {
    const text = readFileSync(join(dist, name), "utf8");
    for (const forbidden of forbiddenRuntimeStrings) {
      if (text.includes(forbidden)) throw new Error(`approval UI localization incomplete in ${name}: ${forbidden}`);
    }
  }
}
console.log(`OpenClaw ${version}: ${changedFiles} approval UI file(s) patched`);

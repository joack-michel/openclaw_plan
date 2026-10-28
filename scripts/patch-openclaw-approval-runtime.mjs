#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { audit, recordTransaction, requireLocalAdmin, STATE_DIR, withAdminLock } from "../src/admin/local-admin.js";

const DEFAULT_LAUNCHER = process.env.OPENCLAW_LAUNCHER || String(spawnSync("which", ["openclaw"], { encoding: "utf8" }).stdout || "").trim();
const HELPER_NAME = "execution-gate-approval-delivery-dedupe.js";
// Hash of the inspected deployed helper; refuse unrelated local helper edits.
const LEGACY_HELPER_SHA256 = process.env.OPENCLAW_APPROVAL_LEGACY_SHA256 || ["8781be","193176","31d427","4d6a0c","d69409","364338","c9ea83","44dc0b","3f7212","47a19e","48d5"].join("");
const OLD_IMPORT = 'import { claimTelegramApprovalDelivery, markTelegramApprovalDeliverySent } from "./' + HELPER_NAME + '";';
const NEW_IMPORT = 'import { claimTelegramApprovalDelivery, markTelegramApprovalDeliverySent, markTelegramApprovalDeliveryUncertain } from "./' + HELPER_NAME + '";';
const UPSTREAM_DELIVERY = "\t\tdeliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {\n\t\t\tconst resolved = resolveHandlerContext({\n\t\t\t\tcfg,\n\t\t\t\taccountId,\n\t\t\t\tcontext\n\t\t\t});\n\t\t\tif (!resolved) return null;\n\t\t\tconst sendTyping = resolved.context.deps?.sendTyping ?? sendTypingTelegram;\n\t\t\tconst sendMessage = resolved.context.deps?.sendMessage ?? sendMessageTelegram;\n\t\t\tconst options = {\n\t\t\t\tcfg,\n\t\t\t\ttoken: resolved.context.token,\n\t\t\t\taccountId: resolved.accountId,\n\t\t\t\t...preparedTarget.messageThreadId != null ? { messageThreadId: preparedTarget.messageThreadId } : {}\n\t\t\t};\n\t\t\tawait sendTyping(preparedTarget.chatId, options).catch(() => {});\n\t\t\tconst result = await sendMessage(preparedTarget.chatId, pendingPayload.text, {\n\t\t\t\t...options,\n\t\t\t\tbuttons: pendingPayload.buttons,\n\t\t\t\t...preparedTarget.directMessagesTopicId != null ? { directMessagesTopicId: preparedTarget.directMessagesTopicId } : {}\n\t\t\t});\n\t\t\treturn {\n\t\t\t\tchatId: result.chatId,\n\t\t\t\tmessageId: result.messageId\n\t\t\t};\n\t\t},";
const LEGACY_DELIVERY = "\t\tdeliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {\n\t\t\tconst resolved = resolveHandlerContext({\n\t\t\t\tcfg,\n\t\t\t\taccountId,\n\t\t\t\tcontext\n\t\t\t});\n\t\t\tif (!resolved) return null;\n\t\t\tconst sendTyping = resolved.context.deps?.sendTyping ?? sendTypingTelegram;\n\t\t\tconst sendMessage = resolved.context.deps?.sendMessage ?? sendMessageTelegram;\n\t\t\tif (!claimTelegramApprovalDelivery({ approvalId: pendingPayload.approvalId, chatId: preparedTarget.chatId })) {\n\t\t\t\tlog.info(`telegram approvals: suppressed duplicate request ${pendingPayload.approvalId} for chat ${preparedTarget.chatId}`);\n\t\t\t\treturn null;\n\t\t\t}\n\t\t\tconst options = {\n\t\t\t\tcfg,\n\t\t\t\ttoken: resolved.context.token,\n\t\t\t\taccountId: resolved.accountId,\n\t\t\t\t...preparedTarget.messageThreadId != null ? { messageThreadId: preparedTarget.messageThreadId } : {}\n\t\t\t};\n\t\t\tawait sendTyping(preparedTarget.chatId, options).catch(() => {});\n\t\t\tconst result = await sendMessage(preparedTarget.chatId, pendingPayload.text, {\n\t\t\t\t...options,\n\t\t\t\tbuttons: pendingPayload.buttons,\n\t\t\t\t...preparedTarget.directMessagesTopicId != null ? { directMessagesTopicId: preparedTarget.directMessagesTopicId } : {}\n\t\t\t});\n\t\t\tmarkTelegramApprovalDeliverySent({ approvalId: pendingPayload.approvalId, chatId: preparedTarget.chatId });\n\t\t\treturn {\n\t\t\t\tchatId: result.chatId,\n\t\t\t\tmessageId: result.messageId\n\t\t\t};\n\t\t},";
const REQUEST_ID_DELIVERY = "\t\tdeliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload, request }) => {\n\t\t\tconst resolved = resolveHandlerContext({\n\t\t\t\tcfg,\n\t\t\t\taccountId,\n\t\t\t\tcontext\n\t\t\t});\n\t\t\tif (!resolved) return null;\n\t\t\tconst sendTyping = resolved.context.deps?.sendTyping ?? sendTypingTelegram;\n\t\t\tconst sendMessage = resolved.context.deps?.sendMessage ?? sendMessageTelegram;\n\t\t\tif (typeof request?.id !== \"string\" || !request.id.trim()) throw new Error(\"native Telegram approval request ID missing\");\n\t\t\tif (!claimTelegramApprovalDelivery({ approvalId: request.id, chatId: preparedTarget.chatId })) {\n\t\t\t\tlog.info(`telegram approvals: suppressed duplicate request ${request.id} for chat ${preparedTarget.chatId}`);\n\t\t\t\treturn null;\n\t\t\t}\n\t\t\tconst options = {\n\t\t\t\tcfg,\n\t\t\t\ttoken: resolved.context.token,\n\t\t\t\taccountId: resolved.accountId,\n\t\t\t\t...preparedTarget.messageThreadId != null ? { messageThreadId: preparedTarget.messageThreadId } : {}\n\t\t\t};\n\t\t\tawait sendTyping(preparedTarget.chatId, options).catch(() => {});\n\t\t\tconst result = await sendMessage(preparedTarget.chatId, pendingPayload.text, {\n\t\t\t\t...options,\n\t\t\t\tbuttons: pendingPayload.buttons,\n\t\t\t\t...preparedTarget.directMessagesTopicId != null ? { directMessagesTopicId: preparedTarget.directMessagesTopicId } : {}\n\t\t\t});\n\t\t\tmarkTelegramApprovalDeliverySent({ approvalId: request.id, chatId: preparedTarget.chatId });\n\t\t\treturn {\n\t\t\t\tchatId: result.chatId,\n\t\t\t\tmessageId: result.messageId\n\t\t\t};\n\t\t},";
const SAFE_DELIVERY = "\t\tdeliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload, request }) => {\n\t\t\tconst resolved = resolveHandlerContext({ cfg, accountId, context });\n\t\t\tif (!resolved) return null;\n\t\t\t// execution-gate Telegram delivery v2: host request identity, at most once.\n\t\t\tif (typeof request?.id !== \"string\" || !request.id.trim() || request.id !== request.id.trim()) throw new Error(\"native Telegram approval request ID missing or invalid\");\n\t\t\tconst delivery = { approvalId: request.id, chatId: preparedTarget.chatId };\n\t\t\tif (!claimTelegramApprovalDelivery(delivery)) {\n\t\t\t\tlog.info(`telegram approvals: suppressed duplicate or uncertain request ${request.id} for chat ${preparedTarget.chatId}`);\n\t\t\t\treturn null;\n\t\t\t}\n\t\t\tconst sendTyping = resolved.context.deps?.sendTyping ?? sendTypingTelegram;\n\t\t\tconst sendMessage = resolved.context.deps?.sendMessage ?? sendMessageTelegram;\n\t\t\tconst options = {\n\t\t\t\tcfg, token: resolved.context.token, accountId: resolved.accountId,\n\t\t\t\t...preparedTarget.messageThreadId != null ? { messageThreadId: preparedTarget.messageThreadId } : {}\n\t\t\t};\n\t\t\ttry {\n\t\t\t\tawait sendTyping(preparedTarget.chatId, options).catch(() => {});\n\t\t\t\tconst result = await sendMessage(preparedTarget.chatId, pendingPayload.text, {\n\t\t\t\t\t...options, buttons: pendingPayload.buttons,\n\t\t\t\t\t...preparedTarget.directMessagesTopicId != null ? { directMessagesTopicId: preparedTarget.directMessagesTopicId } : {}\n\t\t\t\t});\n\t\t\t\tconst validChat = (typeof result?.chatId === \"string\" && Boolean(result.chatId.trim())) || (typeof result?.chatId === \"number\" && Number.isSafeInteger(result.chatId));\n\t\t\t\tconst validMessage = (typeof result?.messageId === \"string\" && /^[1-9][0-9]*$/.test(result.messageId)) || (Number.isSafeInteger(result?.messageId) && result.messageId > 0);\n\t\t\t\tif (!validChat || !validMessage) throw new Error(\"native Telegram approval send returned no valid receipt\");\n\t\t\t\tif (!markTelegramApprovalDeliverySent({ ...delivery, messageId: result.messageId, deliveredChatId: result.chatId })) throw new Error(\"native Telegram approval receipt was not recorded\");\n\t\t\t\treturn { chatId: result.chatId, messageId: result.messageId };\n\t\t\t} catch (error) {\n\t\t\t\t// Never release the claim: Telegram may have accepted a timed-out send.\n\t\t\t\ttry { markTelegramApprovalDeliveryUncertain(delivery); } catch { log.error(\"telegram approvals: delivery state uncertain; durable claim retained\"); }\n\t\t\t\tthrow error;\n\t\t\t}\n\t\t},";

export function patchTelegramApprovalRuntime(source) {
  const start = source.indexOf("\t\tdeliverPending: async (");
  const end = source.indexOf("\n\t\tupdateEntry: async (", start);
  if (start < 0 || end < 0) throw new Error("Telegram delivery handler anchors missing");
  const current = source.slice(start, end);
  if (![UPSTREAM_DELIVERY, LEGACY_DELIVERY, REQUEST_ID_DELIVERY, SAFE_DELIVERY].includes(current)) throw new Error("unrecognized Telegram delivery handler; refusing to overwrite local changes");
  const usesHelper = current !== UPSTREAM_DELIVERY;
  if (usesHelper && !source.includes(OLD_IMPORT) && !source.includes(NEW_IMPORT)) throw new Error("unrecognized installed approval dedupe import");
  let patched = source.slice(0, start) + SAFE_DELIVERY + source.slice(end);
  if (patched.includes(OLD_IMPORT)) patched = patched.replace(OLD_IMPORT, NEW_IMPORT);
  else if (!patched.includes(NEW_IMPORT)) {
    const anchor = patched.match(/import \{ a as buildTelegramNativeResolvedApprovalText, i as buildTelegramNativeExpiredApprovalText \} from "\.\/approval-terminal-[^"\n]+\.m?js";/)?.[0];
    if (!anchor) throw new Error("Telegram approval import anchor missing");
    patched = patched.replace(anchor, anchor + "\n" + NEW_IMPORT);
  }
  return patched;
}

export function planTelegramApprovalRuntimePatch({ launcher = DEFAULT_LAUNCHER } = {}) {
  const text = readFileSync(launcher, "utf8");
  const match = text.match(/"\$basedir\/([^"\n]*\/node_modules\/openclaw\/openclaw\.mjs)"/);
  if (!match) throw new Error(`cannot resolve OpenClaw package from ${launcher}`);
  const packageRoot = dirname(resolve(dirname(launcher), match[1]));
  const dist = join(packageRoot, "dist");
  const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
  const files = readdirSync(dist).filter((name) => /^approval-handler\.runtime-.*\.m?js$/.test(name)).map((name) => join(dist, name)).filter((path) => {
    const source = readFileSync(path, "utf8");
    return source.includes('createSubsystemLogger("telegram/approvals")') && source.includes("sendMessageTelegram");
  });
  if (!files.length) throw new Error("Telegram native approval runtime not found");
  const changes = files.map((path) => {
    const before = readFileSync(path, "utf8");
    return { path, before, after: patchTelegramApprovalRuntime(before) };
  });
  const path = join(dist, HELPER_NAME);
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const after = readFileSync(new URL("../src/approval-delivery-dedupe.js", import.meta.url), "utf8");
  if (before !== null && before !== after && digest(before) !== LEGACY_HELPER_SHA256) throw new Error("unrecognized installed approval dedupe helper; refusing to overwrite local changes");
  changes.push({ path, before, after });
  return { packageRoot, version, changes };
}
function digest(text) { return text === null ? null : createHash("sha256").update(text).digest("hex"); }
export function summarizeTelegramApprovalPatch(plan) {
  return { version: plan.version, packageRoot: plan.packageRoot, changes: plan.changes.map(({ path, before, after }) => ({ path, changed: before !== after, beforeSha256: digest(before), afterSha256: digest(after) })) };
}

// Production writes are available only through the existing local admin check
// and transaction lock. --check below is read-only and needs no management TTY.
export function installTelegramApprovalRuntimePatch() {
  requireLocalAdmin();
  return withAdminLock(() => {
    const plan = planTelegramApprovalRuntimePatch();
    const changes = plan.changes.filter(({ before, after }) => before !== after);
    if (!changes.length) return { ...summarizeTelegramApprovalPatch(plan), status: "ALREADY_INSTALLED" };
    for (const change of changes) {
      const check = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: change.after, encoding: "utf8" });
      if (check.error || check.status !== 0) throw new Error(`approval patch syntax check failed: ${basename(change.path)}`);
    }
    const backupDir = join(STATE_DIR, "openclaw-runtime-patches", plan.version, `telegram-delivery-${Date.now()}`);
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const manifest = summarizeTelegramApprovalPatch(plan);
    writeFileSync(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    for (const { path, before } of changes) if (before !== null) copyFileSync(path, join(backupDir, basename(path)));
    const applied = [];
    try {
      // Install the backward-compatible helper before any handler imports it.
      for (const change of [...changes].sort((a, b) => Number(b.path.endsWith(HELPER_NAME)) - Number(a.path.endsWith(HELPER_NAME)))) {
        const current = existsSync(change.path) ? readFileSync(change.path, "utf8") : null;
        if (current !== change.before) throw new Error(`runtime changed during patch: ${basename(change.path)}`);
        const temp = change.path + `.telegram-patch-${process.pid}`;
        try {
          writeFileSync(temp, change.after, { mode: current === null ? 0o600 : statSync(change.path).mode & 0o777, flag: "wx" });
          renameSync(temp, change.path);
        } finally { rmSync(temp, { force: true }); }
        applied.push(change);
        if (readFileSync(change.path, "utf8") !== change.after) throw new Error("runtime patch verification failed");
      }
      const transactionId = recordTransaction("approvals.patch-telegram-runtime", changes.map((c) => c.path), "COMMITTED", { backupDir, ...manifest });
      return { status: "COMMITTED", transactionId, backupDir, ...manifest };
    } catch (error) {
      for (const change of applied.reverse()) {
        if (change.before === null) rmSync(change.path, { force: true });
        else copyFileSync(join(backupDir, basename(change.path)), change.path);
      }
      audit("approvals.patch-telegram-runtime", { status: "ROLLED_BACK", backupDir });
      throw error;
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === "--check") console.log(JSON.stringify(summarizeTelegramApprovalPatch(planTelegramApprovalRuntimePatch()), null, 2));
  else throw new Error("Use openclaw-admin approvals patch-telegram-runtime; --check is read-only.");
}

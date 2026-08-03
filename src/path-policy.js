import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { isRecord } from "./canonical-json.js";
import { EXECUTION_GATE_HOME, OPENCLAW_HOME, OPENCLAW_WORKSPACE } from "./template-config.js";

export const TRUSTED_ROOTS = [
  OPENCLAW_WORKSPACE,
  resolve(OPENCLAW_WORKSPACE, "skills"),
  resolve(OPENCLAW_HOME, "skills"),
  EXECUTION_GATE_HOME
];

const SAFE_ROOTS = TRUSTED_ROOTS.map((value) => realpathIfExists(value) || resolve(value));

const SAFE_BASENAMES = new Set([
  "SKILL.md",
  "README.md",
  "MEMORY.md"
]);

const SAFE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".jsonl",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".py",
  ".sh",
  ".log",
  ".yaml",
  ".yml"
]);

const SENSITIVE_PATTERNS = [
  /(^|[._/-])env($|[._/-])/i,
  /token/i,
  /credential/i,
  /secret/i,
  /auth/i,
  /private[-_ ]?key/i,
  /api[-_ ]?key/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.crt$/i
];

const FILE_READ_TOOLS = new Set(["read", "dir_list"]);

export function evaluatePathPolicy(event) {
  const toolName = String(event?.toolName || "").trim();
  if (!FILE_READ_TOOLS.has(toolName)) {
    return { action: "NO_MATCH" };
  }
  const params = isRecord(event?.params) ? event.params : {};
  const ctx = isRecord(event?.ctx) ? event.ctx : {};
  const pathValue = String(params.path || params.file || "").trim();
  if (!pathValue) return { action: "FORCE_PROTECTED", reason: "file read path is missing" };
  const resolved = resolveSafePath(pathValue, ctx.workspaceDir);
  if (!resolved.ok || !existsSync(resolved.realPath)) return { action: "FORCE_PROTECTED", reason: resolved.reason || "read target does not exist" };
  let stat;
  try { stat = lstatSync(resolved.realPath); } catch { return { action: "FORCE_PROTECTED", reason: "read target cannot be statted" }; }
  if (toolName === "dir_list" && stat.isDirectory()) return { action: "ALLOW_L0", reason: "local directory listing has no side effect", path: resolved.realPath };
  if (toolName === "read" && stat.isFile()) return { action: "ALLOW_L0", reason: "local file read has no side effect", path: resolved.realPath };
  return { action: "FORCE_PROTECTED", reason: "read target is not a regular file or directory", path: resolved.realPath };
}

export function resolveSafePath(inputPath, workspaceDir = "") {
  const expanded = expandHome(inputPath);
  const absolute = resolve(String(workspaceDir || ""), expanded);
  const realPath = realpathIfExists(absolute) || realpathFromNearestExistingAncestor(absolute);
  if (!realPath) {
    return { ok: false, reason: "path cannot be canonicalized" };
  }
  return { ok: true, realPath };
}

export function isSensitivePath(pathValue) {
  const normalized = String(pathValue || "").replaceAll("\\", "/");
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

// This is deliberately stronger than a lexical prefix test.  Calls receive a
// canonical existing path (or the canonical nearest ancestor for a new file),
// every existing component is checked for ownership and writability, and a
// symlink can never move a trusted request outside its root.
export function trustedWorkspacePath(pathValue, options = {}) {
  const { requireFile = false, requireDirectory = false, allowMissing = false } = options;
  const raw = resolve(expandHome(String(pathValue || "")));
  const existing = existsSync(raw);
  if (!existing && !allowMissing) return { ok: false, code: "UNTRUSTED_PATH", reason: "trusted target does not exist" };
  const canonical = existing ? realpathIfExists(raw) : realpathFromNearestExistingAncestor(raw);
  if (!canonical) return { ok: false, code: "UNTRUSTED_PATH", reason: "trusted target cannot be canonicalized" };
  const root = TRUSTED_ROOTS.map((item) => realpathIfExists(item) || item).find((item) => canonical === item || canonical.startsWith(`${item}${sep}`));
  if (!root) return { ok: false, code: "UNTRUSTED_PATH", reason: "target is outside trusted roots" };
  if (existing) {
    let stat;
    try { stat = statSync(canonical); } catch { return { ok: false, code: "UNTRUSTED_PATH", reason: "target cannot be statted" }; }
    if (requireFile && !stat.isFile()) return { ok: false, code: "UNTRUSTED_PATH", reason: "trusted script must be a regular file" };
    if (requireDirectory && !stat.isDirectory()) return { ok: false, code: "UNTRUSTED_PATH", reason: "trusted project cwd must be a directory" };
    if (!stat.isFile() && !stat.isDirectory()) return { ok: false, code: "UNTRUSTED_PATH", reason: "device, socket, and FIFO targets are denied" };
  }
  for (let cursor = existing ? canonical : dirname(canonical); ; cursor = dirname(cursor)) {
    let stat;
    try { stat = statSync(cursor); } catch { return { ok: false, code: "UNTRUSTED_PATH", reason: "trusted ancestor cannot be statted" }; }
    if (![0, process.getuid?.()].includes(stat.uid)) return { ok: false, code: "UNTRUSTED_PATH", reason: "target owner is not the service user or root" };
    if ((stat.mode & 0o022) !== 0) return { ok: false, code: "UNTRUSTED_PATH", reason: "target or parent is group/world writable" };
    if (cursor === root) break;
    if (cursor === dirname(cursor)) return { ok: false, code: "UNTRUSTED_PATH", reason: "trusted root traversal failed" };
  }
  return { ok: true, realPath: canonical, root };
}

function isSafeOrdinaryFile(pathValue) {
  const name = pathValue.split(sep).pop() || "";
  return SAFE_BASENAMES.has(name) || SAFE_EXTENSIONS.has(extname(name));
}

function isUnderSafeRoot(realPath) {
  return SAFE_ROOTS.some((root) => realPath === root || realPath.startsWith(`${root}${sep}`));
}

function expandHome(pathValue) {
  return pathValue.startsWith("~/") ? resolve(homedir(), pathValue.slice(2)) : pathValue;
}

function realpathIfExists(pathValue) {
  if (!existsSync(pathValue)) {
    return "";
  }
  try {
    return realpathSync(pathValue);
  } catch {
    return "";
  }
}

function realpathFromNearestExistingAncestor(pathValue) {
  const suffix = [];
  let cursor = pathValue;
  while (true) {
    const parent = dirname(cursor);
    if (parent === cursor) return "";
    suffix.unshift(cursor.slice(parent.length + 1));
    const realParent = realpathIfExists(parent);
    if (realParent) return resolve(realParent, ...suffix);
    cursor = parent;
  }
}

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { isRecord } from "./canonical-json.js";
import { EXECUTION_GATE_HOME, OPENCLAW_HOME, OPENCLAW_WORKSPACE } from "./template-config.js";

const SAFE_ROOTS = [
  OPENCLAW_WORKSPACE,
  resolve(OPENCLAW_HOME, "skills"),
  resolve(OPENCLAW_HOME, "agents"),
  EXECUTION_GATE_HOME
].map((value) => realpathIfExists(value) || resolve(value));

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
  if (!pathValue) {
    return { action: "FORCE_PROTECTED", reason: "file read path is missing" };
  }
  const resolved = resolveSafePath(pathValue, ctx.workspaceDir);
  if (!resolved.ok) {
    return { action: "FORCE_PROTECTED", reason: resolved.reason };
  }
  if (isSensitivePath(resolved.realPath)) {
    return { action: "FORCE_PROTECTED", reason: "sensitive file path requires confirmation", path: resolved.realPath };
  }
  if (!isUnderSafeRoot(resolved.realPath)) {
    return { action: "FORCE_PROTECTED", reason: "file path is outside safe workspace roots", path: resolved.realPath };
  }
  if (toolName === "dir_list") {
    return { action: "ALLOW_L0", reason: "safe workspace directory listing", path: resolved.realPath };
  }
  if (isSafeOrdinaryFile(resolved.realPath)) {
    return { action: "ALLOW_L0", reason: "safe ordinary workspace file read", path: resolved.realPath };
  }
  return { action: "FORCE_PROTECTED", reason: "file extension is not in safe read policy", path: resolved.realPath };
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


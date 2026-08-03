import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { EXECUTION_GATE_HOME, OPENCLAW_HOME as CONFIGURED_OPENCLAW_HOME, OPENCLAW_STATE } from "../template-config.js";

export const HOME = dirname(CONFIGURED_OPENCLAW_HOME);
export const OPENCLAW_HOME = CONFIGURED_OPENCLAW_HOME;
export const STATE_DIR = OPENCLAW_STATE;
export const CONFIG_PATH = `${OPENCLAW_HOME}/openclaw.json`;
export const APPROVALS_PATH = `${STATE_DIR}/exec-approvals.json`;
export const REGISTRY_PATH = `${STATE_DIR}/skill-registry.json`;
export const AUDIT_PATH = `${STATE_DIR}/openclaw-admin.audit.log`;
export const HISTORY_PATH = `${STATE_DIR}/openclaw-admin-history.json`;
export const LOCK_PATH = `${STATE_DIR}/openclaw-admin.lock`;
export const GATE_ROOT = EXECUTION_GATE_HOME;
export const RECOVERY = `${GATE_ROOT}/bin/openclaw-recovery`;

const SENSITIVE_FIELD = /token|cookie|password|secret|authorization|api[_-]?key|private[_-]?key|telegram|account|endpoint|url|appId|ownerAllowFrom|allowFrom/i;

export function requireLocalAdmin(env = process.env) {
  if (env.OPENCLAW_ADMIN_TEST_MODE === "1") return;
  if (process.getuid?.() === 0) throw coded("openclaw-admin must run as the OpenClaw service user, not root", 77);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw coded("openclaw-admin requires a local TTY", 77);
  if (/openclaw|gateway/i.test(String(process.ppid && process.env.INVOCATION_ID || ""))) throw coded("Gateway processes may not invoke openclaw-admin", 77);
}

export function ensureAdminState() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 }); chmodSync(STATE_DIR, 0o700);
}

export function withAdminLock(fn) {
  ensureAdminState();
  let fd;
  try { fd = openSync(LOCK_PATH, "wx", 0o600); }
  catch { throw coded("another admin transaction is active", 75); }
  try { return fn(); } finally { try { closeSync(fd); } catch {} try { unlinkSync(LOCK_PATH); } catch {} }
}

export function redact(value, key = "") {
  if (SENSITIVE_FIELD.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

export function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
export function atomicJson(path, value) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, path); chmodSync(path, 0o600);
}
export function sha(value) { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
export function audit(action, detail = {}) {
  ensureAdminState();
  const safe = Object.fromEntries(Object.entries(detail).map(([key, value]) => [key, SENSITIVE_FIELD.test(key) ? sha(String(value)) : value]));
  writeFileSync(AUDIT_PATH, `${new Date().toISOString()} ${JSON.stringify({ user: process.env.USER || "service-user", action, ...safe })}\n`, { flag: "a", mode: 0o600 }); chmodSync(AUDIT_PATH, 0o600);
}
export function recordTransaction(action, paths, status, detail = {}) {
  const history = existsSync(HISTORY_PATH) ? readJson(HISTORY_PATH) : { schemaVersion: 1, transactions: [] };
  const id = `admin-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  history.transactions.push({ id, at: new Date().toISOString(), action, paths, status, detail: redact(detail) });
  atomicJson(HISTORY_PATH, history); audit(action, { transactionId: id, status, paths: paths.join(",") }); return id;
}
export function runRecovery(args) {
  const result = spawnSync(RECOVERY, args, { encoding: "utf8", env: { ...process.env, OPENCLAW_ADMIN_TEST_MODE: process.env.OPENCLAW_ADMIN_TEST_MODE || "" } });
  if (result.status !== 0) throw coded((result.stderr || result.stdout || "recovery command failed").trim(), result.status || 1);
  return (result.stdout || "").trim();
}
export function applyJsonPatch(document, patch) {
  if (!Array.isArray(patch)) throw coded("patch file must be an RFC 6902 JSON array", 64);
  const target = structuredClone(document);
  for (const item of patch) {
    if (!item || !["add", "remove", "replace", "test"].includes(item.op) || typeof item.path !== "string" || !item.path.startsWith("/")) throw coded("unsupported JSON Patch operation", 64);
    const keys = item.path.slice(1).split("/").map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~")); let holder = target;
    for (const key of keys.slice(0, -1)) { if (!holder || typeof holder !== "object" || !(key in holder)) throw coded(`patch path missing: ${item.path}`, 64); holder = holder[key]; }
    const key = keys.at(-1); if (item.op === "test") { if (JSON.stringify(holder[key]) !== JSON.stringify(item.value)) throw coded(`patch test failed: ${item.path}`, 65); }
    else if (item.op === "remove") { if (!(key in holder)) throw coded(`patch path missing: ${item.path}`, 64); Array.isArray(holder) ? holder.splice(Number(key), 1) : delete holder[key]; }
    else if (item.op === "replace") { if (!(key in holder)) throw coded(`patch path missing: ${item.path}`, 64); holder[key] = item.value; }
    else if (Array.isArray(holder) && key === "-") holder.push(item.value); else holder[key] = item.value;
  }
  return target;
}
export function coded(message, code) { const error = new Error(message); error.code = code; return error; }

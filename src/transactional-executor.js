import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const SAFE_ENV = ["LANG", "LC_ALL", "TZ"];
export class TransactionalExecutor {
  constructor({ roots = [process.cwd()], timeoutMs = 120_000, env = process.env } = {}) { this.roots = roots.map((x) => resolve(x)); this.timeoutMs = timeoutMs; this.env = env; this.backups = new Map(); }
  async execute(plan) {
    const steps = [];
    for (const action of plan.actions) { steps.push(await this.run(action, plan.operationId)); }
    return { steps };
  }
  async run(action, operationId) {
    if (action.type === "filesystem.read") return { type: action.type, bytes: readFileSync(this.path(action.target)).length };
    if (action.type === "filesystem.list") return { type: action.type, entries: requireDirectory(this.path(action.target)) };
    if (["filesystem.write", "filesystem.patch"].includes(action.type)) { const target = this.path(action.target); this.backup(operationId, target); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, String(action.content || ""), { mode: 0o600 }); return { type: action.type, target }; }
    if (action.type === "filesystem.mkdir") { const target = this.path(action.target); this.backup(operationId, target); mkdirSync(target, { recursive: true, mode: 0o700 }); return { type: action.type, target }; }
    if (action.type === "filesystem.delete") { if (action.irreversible) throw new Error("irreversible delete denied"); const target = this.path(action.target); this.backup(operationId, target); rmSync(target, { recursive: true, force: true }); return { type: action.type, target }; }
    if (["process.test", "process.build", "process.spawn"].includes(action.type)) return this.process(action);
    if (["network.fetch", "network.head"].includes(action.type)) return this.network(action);
    if (["package.search", "package.inspect"].includes(action.type)) return this.packageQuery(action);
    if (action.type === "service.status") return this.process({ ...action, argv: ["systemctl", "--user", "is-active", action.service] });
    if (["service.reload", "service.restart"].includes(action.type)) return this.process({ ...action, argv: ["systemctl", "--user", action.type.endsWith("reload") ? "reload" : "restart", action.service] });
    if (action.type === "transaction.quote") return { type: action.type, mock: true };
    const error = new Error(`UNSUPPORTED_OPERATION: missing adapter for ${action.type}`); error.code = "UNSUPPORTED_OPERATION"; throw error;
  }
  async rollback(plan) { const saved = this.backups.get(plan.operationId) || []; try { for (const item of saved.reverse()) { if (item.exists) { mkdirSync(dirname(item.target), { recursive: true }); renameSync(item.backup, item.target); } else rmSync(item.target, { recursive: true, force: true }); } return { ok: true }; } catch { return { ok: false }; } }
  backup(operationId, target) { const list = this.backups.get(operationId) || []; const backup = `${target}.operation-backup-${operationId}`; const exists = existsSync(target); if (exists) { const st = lstatSync(target); if (!st.isFile() || st.isSymbolicLink()) throw new Error("unsafe target type"); copyFileSync(target, backup); } list.push({ target, backup, exists }); this.backups.set(operationId, list); }
  path(target) { if (typeof target !== "string") throw new Error("target required"); const full = resolve(target); if (!this.roots.some((root) => full === root || full.startsWith(`${root}/`))) throw new Error("path outside allowed roots"); if (existsSync(full)) { const stat = lstatSync(full); if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error("symlink/device/fifo/socket denied"); } return full; }
  process(action) { const [file, ...argv] = action.argv; if (!file || /^(bash|sh|zsh)$/.test(file) || ["-c", "-e", "--eval"].includes(argv[0])) throw new Error("dynamic process denied"); const cwd = this.path(action.cwd || this.roots[0]); if (!statSync(cwd).isDirectory()) throw new Error("cwd must be directory"); const env = Object.fromEntries(SAFE_ENV.filter((key) => this.env[key]).map((key) => [key, this.env[key]])); env.PATH = "/usr/bin:/bin"; env.HOME = "/nonexistent";
    const result = spawnSync(file, argv, { cwd, env, shell: false, timeout: action.timeoutMs || this.timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 }); if (result.error) throw result.error; if (result.status !== 0) throw new Error(`process failed: ${result.status}`); return { type: action.type, status: result.status, stdoutBytes: Buffer.byteLength(result.stdout || "") }; }
  async network(action) { const url = new URL(action.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("network URL denied"); if (Array.isArray(action.allowedDomains) && action.allowedDomains.length && !action.allowedDomains.includes(url.hostname)) throw new Error("network domain outside frozen scope"); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.min(action.timeoutMs || 15000, 30000)); try { const response = await fetch(url, { method: action.type === "network.head" ? "HEAD" : "GET", redirect: "error", signal: controller.signal }); const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > (action.maxBytes || 256 * 1024)) throw new Error("network response too large"); return { type: action.type, url: `${url.protocol}//${url.host}${url.pathname}`, status: response.status, contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, content: action.type === "network.fetch" ? bytes.toString("utf8").slice(0, action.maxTextChars || 12000) : undefined }; } finally { clearTimeout(timer); } }
  async packageQuery(action) { const name = String(action.name || ""); if (!/^[a-z0-9@][a-z0-9@/_.-]{0,214}$/i.test(name)) throw new Error("invalid package name"); return this.network({ type: "network.fetch", url: `https://registry.npmjs.org/${encodeURIComponent(name)}`, allowedDomains: ["registry.npmjs.org"], maxBytes: 256 * 1024, maxTextChars: 12000 }); }
}
function requireDirectory(path) { return readdirSync(path); }

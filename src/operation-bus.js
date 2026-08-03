import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { newId, sha256Hex, stableStringify } from "./canonical-json.js";

export const OPERATION_STATUSES = Object.freeze(["PLANNED", "WAIT_CONFIRM", "AUTHORIZED", "PREPARING", "READY_TO_COMMIT", "EXECUTING", "SUCCEEDED", "FAILED", "ROLLED_BACK", "ROLLBACK_FAILED", "CANCELLED", "EXPIRED", "DENIED", "ADMIN_PLANE_REQUIRED"]);
export const CONFIRMATION_MODES = Object.freeze(["CONFIRM_ONCE", "SCOPED_TIME_WINDOW", "SCOPED_SESSION_APPROVAL", "INSTALL_TWO_PHASE", "FINANCIAL_STEP_UP", "DENY", "ADMIN_PLANE_REQUIRED", "ALLOW_INTERNAL"]);
export const FINANCIAL_ACTIONS = new Set(["transaction.order.create", "transaction.order.modify", "transaction.order.cancel", "transaction.payment.authorize", "transaction.payment.capture", "transaction.transfer"]);
export const ADMIN_ACTIONS = new Set(["security.policy.patch", "security.operation-store.patch", "security.audit.patch", "security.integrity.patch", "security.bootstrap.patch"]);
const SENSITIVE_FIELD = /(?:token|cookie|authorization|password|private.?key|secret)/i;
const DYNAMIC = /^(?:bash|sh|zsh)$|^(?:node|python|python3|perl|ruby)$/;

export class OperationBus {
  constructor({ dbPath, executor, bootId = newId("boot"), now = () => Date.now() } = {}) {
    if (!dbPath) throw new Error("dbPath required");
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.executor = executor;
    this.bootId = bootId;
    this.now = now;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS bus_operations (id TEXT PRIMARY KEY, plan_json TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, confirmed_at INTEGER, boot_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bus_authorizations (id TEXT PRIMARY KEY, auth_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, boot_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bus_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, operation_id TEXT, authorization_id TEXT, event TEXT NOT NULL, details_json TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  createPlan(input) {
    const now = this.now();
    const plan = normalizePlan(input, now);
    const policy = evaluatePlanPolicy(plan);
    plan.status = policy.mode === "DENY" ? "DENIED" : policy.mode === "ADMIN_PLANE_REQUIRED" ? "ADMIN_PLANE_REQUIRED" : "WAIT_CONFIRM";
    plan.confirmationMode = policy.mode;
    plan.canonicalHash = `sha256:${sha256Hex(stableStringify(hashablePlan(plan)))}`;
    this.db.prepare("INSERT INTO bus_operations(id,plan_json,hash,status,created_at,expires_at,boot_id) VALUES(?,?,?,?,?,?,?)").run(plan.operationId, stableStringify(plan), plan.canonicalHash, plan.status, now, plan.expiresAt, this.bootId);
    this.audit(plan.operationId, null, "operation.created", { status: plan.status, actionTypes: plan.actions.map((a) => a.type), canonicalHash: plan.canonicalHash });
    return plan;
  }
  get(operationId) { const row = this.db.prepare("SELECT * FROM bus_operations WHERE id=?").get(operationId); return row ? { ...row, plan: JSON.parse(row.plan_json) } : null; }
  createAuthorization({ type, actor, scope, expiresAt }) {
    if (!["SCOPED_TIME_WINDOW", "SCOPED_SESSION_APPROVAL"].includes(type)) throw new Error("invalid authorization type");
    const now = this.now();
    if (!actor?.id || !actor?.channel || !actor?.sessionId || !scope || !Number.isFinite(expiresAt) || expiresAt <= now) throw new Error("invalid authorization");
    const auth = { authorizationId: newId("auth"), type, actor: pickActor(actor), createdAt: now, expiresAt, scope: normalizeScope(scope), bootId: this.bootId };
    this.db.prepare("INSERT INTO bus_authorizations(id,auth_json,status,created_at,expires_at,boot_id) VALUES(?,?,?,?,?,?)").run(auth.authorizationId, stableStringify(auth), "ACTIVE", now, expiresAt, this.bootId);
    this.audit(null, auth.authorizationId, "authorization.created", { type, actor: auth.actor, expiresAt, scope: auth.scope });
    return auth;
  }
  authorize({ operationId, canonicalHash, actor, authorizationId = "" }) {
    const op = this.get(operationId); const now = this.now();
    if (!op) return fail("NOT_FOUND");
    if (op.status !== "WAIT_CONFIRM") return fail(op.consumed ? "ALREADY_CONSUMED" : op.status);
    if (op.expires_at <= now) return this.expire(op);
    if (op.hash !== canonicalHash) return fail("HASH_MISMATCH");
    if (!sameActor(op.plan.actor, actor)) return fail("ACTOR_SCOPE_MISMATCH");
    const mode = op.plan.confirmationMode;
    if (mode === "DENY" || mode === "ADMIN_PLANE_REQUIRED") return fail(mode);
    if (mode === "FINANCIAL_STEP_UP" && !isExplicitFinancialConfirmation(actor?.confirmationText, op.plan)) return fail("FINANCIAL_CONFIRMATION_REQUIRED");
    if (authorizationId) {
      const auth = this.loadAuthorization(authorizationId);
      if (!auth || !authorizationAllows(auth, op.plan, actor, now, this.bootId)) return fail("AUTHORIZATION_SCOPE_DENIED");
      if (mode === "FINANCIAL_STEP_UP" || mode === "INSTALL_TWO_PHASE") return fail("STEP_UP_REQUIRED");
    }
    const result = this.db.prepare("UPDATE bus_operations SET status='AUTHORIZED', confirmed_at=?, consumed=1 WHERE id=? AND status='WAIT_CONFIRM' AND consumed=0").run(now, operationId);
    if (result.changes !== 1) return fail("ALREADY_CONSUMED");
    this.audit(operationId, authorizationId || null, "operation.authorized", { canonicalHash, mode });
    return { ok: true, operation: this.get(operationId).plan };
  }
  async execute(operationId) {
    const op = this.get(operationId); if (!op) return fail("NOT_FOUND");
    if (op.status !== "AUTHORIZED" && op.status !== "READY_TO_COMMIT") return fail(op.consumed ? "ALREADY_CONSUMED" : op.status);
    const moved = this.db.prepare("UPDATE bus_operations SET status='EXECUTING' WHERE id=? AND status IN ('AUTHORIZED','READY_TO_COMMIT')").run(operationId);
    if (moved.changes !== 1) return fail("ALREADY_CONSUMED");
    this.audit(operationId, null, "execution.started", { canonicalHash: op.hash });
    try {
      if (!this.executor) throw new Error("executor unavailable");
      const result = await this.executor.execute(op.plan);
      this.db.prepare("UPDATE bus_operations SET status='SUCCEEDED' WHERE id=?").run(operationId);
      this.audit(operationId, null, "execution.succeeded", { steps: result?.steps || [] });
      return { ok: true, result };
    } catch (error) {
      const rollback = await this.executor?.rollback?.(op.plan, error);
      const status = rollback?.ok ? "ROLLED_BACK" : "FAILED";
      this.db.prepare("UPDATE bus_operations SET status=? WHERE id=?").run(status, operationId);
      this.audit(operationId, null, "execution.failed", { error: redact(String(error?.message || error)), rollback: rollback?.ok ? "ROLLED_BACK" : "NOT_AVAILABLE" });
      return { ok: false, code: status, error: redact(String(error?.message || error)) };
    }
  }
  readyToCommit(operationId, stagingHash) {
    const op = this.get(operationId); if (!op || op.status !== "AUTHORIZED" || op.plan.confirmationMode !== "INSTALL_TWO_PHASE") return fail("INVALID_INSTALL_STATE");
    const changed = this.db.prepare("UPDATE bus_operations SET status='READY_TO_COMMIT', consumed=0 WHERE id=? AND status='AUTHORIZED'").run(operationId);
    if (changed.changes !== 1) return fail("INVALID_INSTALL_STATE");
    this.audit(operationId, null, "install.prepared", { stagingHash }); return { ok: true };
  }
  authorizeInstallCommit({ operationId, canonicalHash, actor, stagingHash }) {
    const op = this.get(operationId); if (!op) return fail("NOT_FOUND"); if (op.status !== "READY_TO_COMMIT") return fail(op.consumed ? "ALREADY_CONSUMED" : op.status);
    if (op.hash !== canonicalHash || !sameActor(op.plan.actor, actor)) return fail("HASH_OR_ACTOR_MISMATCH");
    const changed = this.db.prepare("UPDATE bus_operations SET status='AUTHORIZED', consumed=1 WHERE id=? AND status='READY_TO_COMMIT' AND consumed=0").run(operationId);
    if (changed.changes !== 1) return fail("ALREADY_CONSUMED"); this.audit(operationId, null, "install.commit.authorized", { stagingHash }); return { ok: true };
  }
  completeExternal(operationId, ok, details = {}) { const op = this.get(operationId); if (!op || op.status !== "AUTHORIZED") return fail("INVALID_STATE"); this.db.prepare("UPDATE bus_operations SET status=? WHERE id=?").run(ok ? "SUCCEEDED" : "ROLLED_BACK", operationId); this.audit(operationId, null, ok ? "execution.succeeded" : "execution.rolled_back", details); return { ok }; }
  expire(op) { this.db.prepare("UPDATE bus_operations SET status='EXPIRED' WHERE id=? AND status='WAIT_CONFIRM'").run(op.id); this.audit(op.id, null, "operation.expired", {}); return fail("EXPIRED"); }
  loadAuthorization(id) { const row = this.db.prepare("SELECT * FROM bus_authorizations WHERE id=? AND status='ACTIVE'").get(id); return row ? JSON.parse(row.auth_json) : null; }
  audit(operationId, authorizationId, event, details) { this.db.prepare("INSERT INTO bus_audit(ts,operation_id,authorization_id,event,details_json) VALUES(?,?,?,?,?)").run(this.now(), operationId, authorizationId, event, stableStringify(redactObject(details))); }
  auditFor(id) { return this.db.prepare("SELECT * FROM bus_audit WHERE operation_id=? OR authorization_id=? ORDER BY id").all(id, id).map((row) => ({ ...row, details: JSON.parse(row.details_json) })); }
}

function normalizePlan(input, now) {
  const actor = pickActor(input.actor); if (!actor.id || !actor.channel || !actor.sessionId) throw new Error("actor id/channel/sessionId required");
  const inputActions = Array.isArray(input.actions) ? input.actions : Array.isArray(input.steps) ? input.steps.map(legacyStepToAction) : [];
  if (!inputActions.length) throw new Error("actions required");
  const expiresAt = Number(input.expiresAt || now + 15 * 60_000); if (expiresAt <= now) throw new Error("operation already expired");
  const plan = { operationId: input.operationId || newId("op"), schemaVersion: 1, actor, summary: String(input.summary || input.description || "operation").slice(0, 500), purpose: String(input.purpose || input.description || "").slice(0, 500), actions: inputActions.map(normalizeAction), expectedEffects: Array.isArray(input.expectedEffects) ? input.expectedEffects : [], rollbackPlan: Array.isArray(input.rollbackPlan) ? input.rollbackPlan : [], risk: { domain: input.risk?.domain === "FINANCIAL_TRANSACTION" ? "FINANCIAL_TRANSACTION" : "OPERATIONAL", level: input.risk?.level || "NORMAL" }, createdAt: now, expiresAt, status: "PLANNED" };
  return plan;
}
function legacyStepToAction(step = {}) { const params = step.params || {}; const type = step.action === "write" ? "filesystem.write" : step.action === "read" ? "filesystem.read" : step.action === "list" ? "filesystem.list" : ""; if (!type) throw new Error("unsupported legacy step"); return { type, target: params.path, ...(type === "filesystem.write" ? { content: params.content } : {}) }; }
function normalizeAction(action) {
  if (!action || typeof action.type !== "string") throw new Error("structured action type required");
  if (action.command || action.shell || action.rawCommand) throw new Error("free shell command prohibited");
  if (/^process\./.test(action.type)) {
    if (!Array.isArray(action.argv) || !action.argv.length || !action.argv.every((x) => typeof x === "string")) throw new Error("process actions require argv");
    if (DYNAMIC.test(action.argv[0]) && ["-c", "-e", "--eval"].includes(action.argv[1])) throw new Error("dynamic shell or inline code denied");
  }
  if (SENSITIVE_FIELD.test(JSON.stringify(action))) throw new Error("secret material prohibited in operation plan");
  return JSON.parse(JSON.stringify(action));
}
function evaluatePlanPolicy(plan) {
  if (plan.actions.some((a) => ADMIN_ACTIONS.has(a.type))) return { mode: "ADMIN_PLANE_REQUIRED" };
  if (plan.actions.some((a) => /(?:filesystem\.delete|package\.remove)/.test(a.type) && a.irreversible)) return { mode: "DENY" };
  if (plan.actions.some((a) => /(?:mkfs|wipefs|fdisk|sudoers|\.ssh)/i.test(JSON.stringify(a)))) return { mode: "DENY" };
  if (plan.actions.some((a) => FINANCIAL_ACTIONS.has(a.type))) return { mode: "FINANCIAL_STEP_UP" };
  if (plan.actions.some((a) => /^(?:skill\.(?:activate|deactivate)|plugin\.(?:activate|deactivate)|package\.(?:install|remove))$/.test(a.type) || a.installPhase)) return { mode: "INSTALL_TWO_PHASE" };
  return { mode: "CONFIRM_ONCE" };
}
function hashablePlan(plan) { const clone = { ...plan }; delete clone.canonicalHash; delete clone.status; delete clone.confirmationMode; return clone; }
function pickActor(actor = {}) { return { id: String(actor.id || ""), channel: String(actor.channel || ""), sessionId: String(actor.sessionId || "") }; }
function sameActor(expected, supplied) { const a = pickActor(supplied); return expected.id === a.id && expected.channel === a.channel && expected.sessionId === a.sessionId; }
function normalizeScope(scope) { return { operationClasses: Array.isArray(scope.operationClasses) ? scope.operationClasses : [], pathRoots: Array.isArray(scope.pathRoots) ? scope.pathRoots : [], networkDomains: Array.isArray(scope.networkDomains) ? scope.networkDomains : [], allowDelete: false, allowInstall: false, allowExternalSend: false, allowFinancialTransaction: false, allowSecretAccess: false, allowAdminPlane: false }; }
function authorizationAllows(auth, plan, actor, now, bootId) { if (auth.bootId !== bootId || auth.expiresAt <= now || !sameActor(auth.actor, actor)) return false; if (plan.actions.some((a) => FINANCIAL_ACTIONS.has(a.type) || /^(?:external\.|transaction\.|package\.install|filesystem\.delete)/.test(a.type))) return false; return plan.actions.every((a) => auth.scope.operationClasses.includes(a.type) && (!a.target || auth.scope.pathRoots.some((root) => a.target === root || a.target.startsWith(`${root}/`)))); }
function isExplicitFinancialConfirmation(text, plan) { const id = plan.operationId.replace(/^op_/, ""); return typeof text === "string" && new RegExp(`^确认(?:支付|转账|下单)\\s+(?:${id}|${plan.operationId})$`).test(text.trim()); }
function redact(value) { return value.replace(/(?:token|cookie|authorization|password|private.?key)\s*[:=]\s*[^\s,]+/ig, "$1=[REDACTED]"); }
function redactObject(value) { return JSON.parse(JSON.stringify(value, (key, current) => SENSITIVE_FIELD.test(key) ? "[REDACTED]" : typeof current === "string" ? redact(current) : current)); }
function fail(code) { return { ok: false, code }; }

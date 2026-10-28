import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plugin from "../src/index.js";
import { OperationStore } from "../src/operation-store.js";
import { CronRunRegistry } from "../src/cron-approval-bypass.js";
import { GrantStore } from "../src/grant-store.js";
import { buildAutomationGrantFromCron } from "../src/automation-scope.js";

const BAIPIAO_JOB = "cron-baipiao";
const REM_JOB = "cron-rem";
const rules = [
  { id: "baipiao-daily", agentId: "main", jobIds: [BAIPIAO_JOB], allowTools: ["exec", "read", "write", "message", "mcd-mcp__auto-bind-coupons"], bypassApproval: true, audit: true, dedupe: true },
  { id: "rem-maintenance", agentId: "main", jobIds: [REM_JOB], allowTools: ["exec", "read", "write", "edit"], bypassApproval: true, audit: true, dedupe: true }
];

function directCron(agentId, jobId, runId, schedulerRunId = runId) { return { agentId, jobId, trigger: "cron", runId, sessionId: `session-${runId}`, sessionKey: `agent:${agentId}:cron:${jobId}:run:${schedulerRunId}` }; }
function harness(dbPath) {
  const policies = []; const hooks = new Map();
  plugin.register({ pluginConfig: { dbPath, operationTtlMs: 60_000, cronApprovalBypassRules: rules }, logger: { info() {} }, registerTrustedToolPolicy: (policy) => policies.push(policy), on: (name, fn) => hooks.set(name, fn) });
  return { policy: policies[0], hooks, dbPath };
}
function withHarness(fn) { const dir = mkdtempSync(join(tmpdir(), "cron-bypass-")); return Promise.resolve(fn(harness(join(dir, "state.sqlite")))).finally(() => rmSync(dir, { recursive: true, force: true })); }
async function register(hooks, ctx) { await hooks.get("before_agent_run")({}, ctx); }
const execEvent = (toolCallId = "call-1", params = { command: "npm test", cwd: "/tmp/openclaw-template-user/openclaw-execution-gate" }) => ({ toolName: "exec", toolCallId, params });

test("registered direct white-freebie Cron bypasses WAIT_CONFIRM without a frozen operation and writes audit", async () => withHarness(async ({ policy, hooks, dbPath }) => {
  const ctx = directCron("main", BAIPIAO_JOB, "run-baipiao-1");
  await register(hooks, ctx);
  const result = await policy.evaluate(execEvent(), ctx);
  assert.equal(result.allow, true);
  assert.equal(result.reason, "CRON_APPROVAL_BYPASS baipiao-daily");
  const store = new OperationStore(dbPath); store.open();
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM operations").get().n, 0);
  await hooks.get("after_tool_call")({ ...execEvent(), result: { exitCode: 0 } }, ctx);
  const audit = store.db.prepare("SELECT event_type, details_json FROM audit_log WHERE event_type LIKE 'cron_approval_bypass.%' ORDER BY id").all();
  assert.deepEqual(audit.map((row) => row.event_type), ["cron_approval_bypass.started", "cron_approval_bypass.completed"]);
  assert.match(audit[0].details_json, /baipiao-daily/); assert.match(audit[1].details_json, /SUCCEEDED/);
  store.close();
}));

test("actual Gateway cron accepts distinct agent runId and scheduler run suffix", async () => withHarness(async ({ policy, hooks }) => {
  const registered = directCron("main", BAIPIAO_JOB, "agent-turn-2026", "scheduler-run-2026");
  await register(hooks, registered);
  // The tool hook carries run/session identity but does not carry trigger/jobId.
  const toolCtx = { agentId: registered.agentId, runId: registered.runId, sessionId: registered.sessionId, sessionKey: registered.sessionKey };
  const result = await policy.evaluate(execEvent("cron-distinct-run-ids"), toolCtx);
  assert.equal(result.allow, true);
  assert.equal(result.reason, "CRON_APPROVAL_BYPASS baipiao-daily");
}));

test("cron-shaped sessions without host cron origin cannot create a bypass", async () => withHarness(async ({ policy, hooks }) => {
  const forged = { ...directCron("main", BAIPIAO_JOB, "actor-run", "session-run"), trigger: "interactive" };
  await register(hooks, forged);
  assert.equal((await policy.evaluate(execEvent("forged-cron-origin"), forged)).requireApproval.title, "TASK_CONFIRM");
  const mismatched = { ...directCron("main", BAIPIAO_JOB, "another-actor-run", "another-session-run"), jobId: REM_JOB };
  await register(hooks, mismatched);
  assert.equal((await policy.evaluate(execEvent("forged-cron-job"), mismatched)).requireApproval.title, "TASK_CONFIRM");
}));

test("a second agent run cannot inherit a registered cron's approval", async () => withHarness(async ({ policy, hooks }) => {
  const original = directCron("main", BAIPIAO_JOB, "first-agent-run", "shared-scheduler-run");
  await register(hooks, original);
  const second = { ...original, runId: "second-agent-run" };
  assert.equal((await policy.evaluate(execEvent("second-agent-run"), second)).requireApproval.title, "TASK_CONFIRM");
}));

test("white-freebie Cron result notification bypasses approval for the exact production run", async () => withHarness(async ({ policy, hooks }) => {
  const ctx = directCron("main", BAIPIAO_JOB, "run-baipiao-message"); await register(hooks, ctx);
  const result = await policy.evaluate({ toolName: "message", toolCallId: "notify-owner", params: { action: "send", channel: "telegram", target: process.env.TELEGRAM_USER_ID || "1000000", message: "daily result" } }, ctx);
  assert.equal(result.allow, true);
  assert.equal(result.reason, "CRON_APPROVAL_BYPASS baipiao-daily");
}));

test("white-freebie Cron may persist its meter state without approval", async () => withHarness(async ({ policy, hooks }) => {
  const ctx = directCron("main", BAIPIAO_JOB, "run-baipiao-meter-state"); await register(hooks, ctx);
  const result = await policy.evaluate({ toolName: "write", toolCallId: "meter-state", params: { path: "/tmp/openclaw-template-user/.openclaw/workspace/skills/lsuke-meter/state/meter_state.json", content: "{}" } }, ctx);
  assert.equal(result.allow, true);
  assert.equal(result.reason, "CRON_APPROVAL_BYPASS baipiao-daily");
}));

test("white-freebie Cron never extends its bypass to sub-agent spawning", async () => withHarness(async ({ policy, hooks }) => {
  const ctx = directCron("main", BAIPIAO_JOB, "run-baipiao-no-spawn"); await register(hooks, ctx);
  const result = await policy.evaluate({ toolName: "sessions_spawn", toolCallId: "spawn", params: { task: "do work" } }, ctx);
  assert.equal(result.allow, false); assert.match(result.reason, /CRON_TOOL_OUT_OF_SCOPE/);
}));

test("registered REM Cron uses its actual main-agent direct run", async () => withHarness(async ({ policy, hooks }) => {
  const ctx = directCron("main", REM_JOB, "run-rem-1"); await register(hooks, ctx);
  const result = await policy.evaluate({ toolName: "write", toolCallId: "rem-write", params: { path: "/tmp/openclaw-template-user/.openclaw/workspace/memory/rem-state.json", content: "{}" } }, ctx);
  assert.equal(result.allow, true); assert.equal(result.reason, "CRON_APPROVAL_BYPASS rem-maintenance");
}));

test("overlapping tool rules continue past a non-matching first job", async () => withHarness(async ({ policy, hooks }) => {
  const ctx = directCron("main", REM_JOB, "run-rem-exec"); await register(hooks, ctx);
  const result = await policy.evaluate(execEvent("rem-exec"), ctx);
  assert.equal(result.allow, true);
  assert.equal(result.reason, "CRON_APPROVAL_BYPASS rem-maintenance");
}));

test("manual start, delegated run, mismatched job, tool, and forged parameters all require normal approval", async () => withHarness(async ({ policy, hooks }) => {
  const manual = { agentId: "main", runId: "manual", sessionKey: "agent:main:telegram:owner" };
  assert.equal((await policy.evaluate(execEvent("manual"), manual)).requireApproval.title, "TASK_CONFIRM");
  const delegated = { ...directCron("main", BAIPIAO_JOB, "delegated"), delegatedByAgentId: "openclaw" }; await register(hooks, delegated);
  assert.equal((await policy.evaluate(execEvent("delegated"), delegated)).requireApproval.title, "TASK_CONFIRM");
  const wrongJob = directCron("main", "other-job", "wrong-job"); await register(hooks, wrongJob);
  assert.equal((await policy.evaluate(execEvent("wrong-job"), wrongJob)).requireApproval.title, "TASK_CONFIRM");
  const valid = directCron("main", BAIPIAO_JOB, "tool-mismatch"); await register(hooks, valid);
  assert.equal((await policy.evaluate({ toolName: "edit", toolCallId: "wrong-tool", params: { path: "/tmp/x", oldText: "x", newText: "y" } }, valid)).allow, false);
  const forged = { workspaceDir: "/tmp/openclaw-template-user/.openclaw/workspace", agentId: "main", runId: "forged", sessionKey: "agent:main:telegram:owner" };
  const forgedResult = await policy.evaluate({ toolName: "exec", toolCallId: "forged", params: { command: "npm test", agentId: "main", source: "cron", cronJobId: BAIPIAO_JOB, runId: "run-baipiao-1" } }, forged);
  assert.equal(forgedResult.requireApproval.title, "TASK_CONFIRM");
}));

test("direct Cron bypass never overrides financial, secret, admin, or destructive classification", async () => withHarness(async ({ policy, hooks }) => {
  const ctx = directCron("main", BAIPIAO_JOB, "risk-boundaries"); await register(hooks, ctx);
  assert.equal((await policy.evaluate({ toolName: "mcd-mcp__create-order", toolCallId: "financial", params: { sku: "burger" } }, ctx)).requireApproval.title, "FINANCIAL_STEP_UP");
  const secret = await policy.evaluate({ toolName: "exec", toolCallId: "secret", params: { command: "curl https://example.test -H 'Authorization: Bearer token123'" } }, ctx);
  assert.equal(secret.allow, false); assert.match(secret.reason, /credential export/);
  const admin = await policy.evaluate({ toolName: "write", toolCallId: "admin", params: { path: "/tmp/openclaw-template-user/openclaw-execution-gate/src/index.js", content: "x" } }, ctx);
  assert.equal(admin.allow, false); assert.match(admin.reason, /ADMIN_PLANE_REQUIRED/);
  const destructive = await policy.evaluate({ toolName: "exec", toolCallId: "destroy", params: { command: "dd if=/dev/zero of=/dev/sda" } }, ctx);
  assert.equal(destructive.allow, false); assert.match(destructive.reason, /block-device/);
}));

test("dedupe is scoped to runId: duplicate same-run effect is denied while a new run is allowed", async () => withHarness(async ({ policy, hooks }) => {
  const one = directCron("main", BAIPIAO_JOB, "run-one"); await register(hooks, one);
  assert.equal((await policy.evaluate(execEvent("one"), one)).allow, true);
  const duplicate = await policy.evaluate(execEvent("two"), one); assert.equal(duplicate.allow, false); assert.match(duplicate.reason, /DUPLICATE/);
  const two = directCron("main", BAIPIAO_JOB, "run-two"); await register(hooks, two);
  assert.equal((await policy.evaluate(execEvent("three"), two)).allow, true);
}));

test("tool hook and model parameters cannot register an otherwise Cron-shaped session", async () => withHarness(async ({ policy, hooks, dbPath }) => {
  for (const [i, change] of [{ trigger: undefined }, { jobId: undefined }, { trigger: "user" }, { cronJobId: REM_JOB }, { sessionId: undefined }].entries()) {
    const forged = { ...directCron("main", BAIPIAO_JOB, `forged-${i}`, `scheduler-${i}`), ...change };
    await hooks.get("before_agent_run")({ trigger: "cron", jobId: BAIPIAO_JOB }, forged);
    const result = await policy.evaluate(execEvent(`forged-${i}`, { command: "npm test", cwd: "/tmp/openclaw-template-user/.openclaw/workspace", trigger: "cron", jobId: BAIPIAO_JOB }), forged);
    assert.notEqual(result.allow, true);
  }
  const unregistered = directCron("main", BAIPIAO_JOB, "unregistered", "scheduler-unregistered");
  assert.notEqual((await policy.evaluate(execEvent("unregistered"), unregistered)).allow, true);
  const store = new OperationStore(dbPath); store.open();
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM trusted_cron_runs").get().n, 0);
  store.close();
}));

test("all Cron execution identity fields must match the persisted record", async () => withHarness(async ({ policy, hooks, dbPath }) => {
  const ctx = directCron("main", BAIPIAO_JOB, "agent-run", "scheduler-run");
  await register(hooks, ctx);
  for (const [i, change] of [
    { agentId: "other" }, { runId: "other-run" }, { sessionId: "other-session" },
    { sessionKey: `agent:main:cron:${BAIPIAO_JOB}:run:other-scheduler` },
    { jobId: REM_JOB }, { cronJobId: REM_JOB }, { trigger: "user" },
    { sessionKey: `agent:main:cron:${REM_JOB}:run:scheduler-run`, jobId: REM_JOB },
    { agentId: "other", sessionKey: `agent:other:cron:${BAIPIAO_JOB}:run:scheduler-run` }
  ].entries()) {
    assert.notEqual((await policy.evaluate(execEvent(`identity-${i}`), { ...ctx, ...change })).allow, true, JSON.stringify(change));
  }
  // A mismatched agent_end must not revoke someone else's execution.
  await hooks.get("agent_end")({ success: true }, { ...ctx, agentId: "other" });
  assert.equal((await policy.evaluate(execEvent("still-bound"), ctx)).allow, true);
  await hooks.get("agent_end")({ success: true }, ctx);
  assert.notEqual((await policy.evaluate(execEvent("after-end", { command: "npm run build", cwd: "/tmp/openclaw-template-user/.openclaw/workspace" }), ctx)).allow, true);
  const store = new OperationStore(dbPath); store.open();
  assert.equal(new CronRunRegistry(store).bindDirectGatewayCron({ ...ctx, sessionId: "replacement" }).ok, false);
  store.close();
}));

test("a persisted Automation Grant cannot bypass the trusted Cron identity check", async () => withHarness(async ({ policy, hooks, dbPath }) => {
  const store = new OperationStore(dbPath); store.open();
  const grants = new GrantStore(store);
  const job = { id: BAIPIAO_JOB, name: "coupon fixture", agentId: "main", enabled: true, schedule: { kind: "cron", expr: "1 0 * * *" }, payload: { kind: "agentTurn", message: "调用 mcd-mcp__auto-bind-coupons 领取免费优惠券" } };
  grants.upsertGrant(buildAutomationGrantFromCron(job));
  const ctx = directCron("main", BAIPIAO_JOB, "grant-run", "grant-scheduler");
  await register(hooks, ctx);
  const call = { toolName: "mcd-mcp__auto-bind-coupons", toolCallId: "grant-call", params: {} };
  assert.equal((await policy.evaluate(call, ctx)).allow, true);
  assert.equal((await policy.evaluate({ ...call, toolCallId: "financial-grant", params: { note: "payment" } }, ctx)).requireApproval.title, "FINANCIAL_STEP_UP");
  for (const change of [{ runId: "other" }, { agentId: "other" }, { sessionId: "other" }, { trigger: "user" }]) {
    assert.notEqual((await policy.evaluate(call, { ...ctx, ...change })).allow, true);
  }
  const forged = { ...ctx, runId: "forged", sessionKey: `agent:main:cron:${BAIPIAO_JOB}:run:forged`, trigger: "user" };
  await register(hooks, forged);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM automation_grant_runs WHERE run_id = 'forged'").get().n, 0);
  store.close();
}));

test("legacy Cron registry schema migrates without trusting old session-less records", () => {
  const dir = mkdtempSync(join(tmpdir(), "cron-schema-"));
  const store = new OperationStore(join(dir, "state.sqlite")); store.open();
  try {
    store.db.exec("CREATE TABLE trusted_cron_runs (run_id TEXT NOT NULL, session_key TEXT NOT NULL, agent_id TEXT NOT NULL, cron_job_id TEXT NOT NULL, launch_source TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL, PRIMARY KEY(run_id, session_key))");
    const ctx = directCron("main", BAIPIAO_JOB, "old", "old-scheduler");
    store.db.prepare("INSERT INTO trusted_cron_runs VALUES (?, ?, ?, ?, 'cron', 1, NULL, 'RUNNING')").run(ctx.runId, ctx.sessionKey, ctx.agentId, ctx.jobId);
    const registry = new CronRunRegistry(store); registry.ensureSchema(); registry.ensureSchema();
    assert.equal(registry.matchesDirectGatewayCron(ctx), null);
    assert.equal(registry.bindDirectGatewayCron(directCron("main", BAIPIAO_JOB, "fresh", "fresh-scheduler")).ok, true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

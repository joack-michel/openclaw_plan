import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plugin from "../src/index.js";
import { OperationStore } from "../src/operation-store.js";
import { CronRunRegistry } from "../src/cron-approval-bypass.js";
import { resolveCapability } from "../src/capability-resolver.js";

const JOB = "fixture-cron-job-id";
const TOOLS = ["exec", "read", "write", "message", "mcd-mcp__auto-bind-coupons"];
const rule = { id: "baipiaowang-daily", agentId: "main", jobIds: [JOB], allowTools: TOOLS, bypassApproval: true, audit: true, dedupe: true };
const owner = { agentId: "main", runId: "owner-turn", sessionKey: "agent:main:telegram:direct:fixture-owner", sessionId: "owner-session", channelId: "telegram", requester: { channel: "telegram", accountId: "default", senderId: "fixture-owner", senderIsOwner: true }, workspaceDir: "/tmp/openclaw-template-user/.openclaw/workspace" };
const runEvent = (params = {}, toolCallId = "manual-start") => ({ toolName: "automations", toolCallId, params: { action: "run", jobId: JOB, runMode: "force", ...params } });
const cronContext = (runId = "agent-run", sessionId = "cron-session", schedulerId = "scheduler-run") => ({ agentId: "main", trigger: "cron", jobId: JOB, runId, sessionId, sessionKey: `agent:main:cron:${JOB}:run:${schedulerId}` });
const writeEvent = (toolCallId = "write") => ({ toolName: "write", toolCallId, params: { path: "/tmp/openclaw-template-user/.openclaw/workspace/skills/lsuke-meter/state/meter_state.json", content: "fixture only" } });
async function harness(fn) {
  const dir = mkdtempSync(join(tmpdir(), "fixed-cron-start-"));
  const policies = []; const hooks = new Map(); const logs = [];
  const dbPath = join(dir, "gate.sqlite");
  const h = { dbPath, hooks, logs, jobs: [{ id: JOB, agentId: "main", enabled: true, sessionTarget: "isolated", payload: { kind: "agentTurn", toolsAllow: [...TOOLS] } }] };
  plugin.register({ pluginConfig: { dbPath, operationTtlMs: 60_000, cronApprovalBypassRules: [rule] }, logger: { info: (s) => logs.push(s) }, registerTrustedToolPolicy: (p) => policies.push(p), on: (name, cb) => hooks.set(name, cb) });
  h.policy = policies[0]; h.gateway = () => hooks.get("gateway_start")({}, { getCron: () => ({ list: async () => h.jobs }) });
  try { await fn(h); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// These calls stop at the policy. No Gateway run or business adapter is invoked.
test("exact owner fixed-job start is approved without a frozen operation and writes audit", () => harness(async (h) => {
  await h.gateway(); const event = runEvent();
  const decision = await h.policy.evaluate(event, owner);
  assert.equal(decision.allow, true); assert.match(decision.reason, /FIXED_CRON_START baipiaowang-daily/);
  await h.hooks.get("after_tool_call")({ ...event, result: { details: { enqueued: true } } }, owner);
  const store = new OperationStore(h.dbPath); store.open();
  try {
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM operations").get().n, 0);
    assert.deepEqual(store.db.prepare("SELECT event_type FROM audit_log WHERE event_type LIKE 'fixed_cron_start.%' ORDER BY id").all().map((x) => x.event_type), ["fixed_cron_start.started", "fixed_cron_start.completed"]);
  } finally { store.close(); }
}));

test("manual authorization requires live Gateway job proof and a trusted owner requester", () => harness(async (h) => {
  assert.notEqual((await h.policy.evaluate(runEvent(), owner)).allow, true);
  await h.gateway();
  for (const change of [
    { requester: undefined }, { requester: { ...owner.requester, senderIsOwner: false } },
    { requester: { ...owner.requester, channel: "webchat" } }, { requester: { ...owner.requester, senderId: "" } },
    { agentId: "other" }, { runId: "" }, { sessionId: "" }, { sessionKey: "agent:other:telegram:owner" },
    { delegatedByAgentId: "parent" }, { sessionKey: `agent:main:cron:${JOB}:run:forged` },
    { abortSignal: AbortSignal.abort() }
  ]) assert.notEqual((await h.policy.evaluate(runEvent(), { ...owner, ...change })).allow, true, JSON.stringify(change));
  const spoof = { ...runEvent(), params: { ...runEvent().params, requester: owner.requester, agentId: "main" } };
  assert.notEqual((await h.policy.evaluate(spoof, { ...owner, requester: undefined })).allow, true);
}));

test("no generic automations create/update/run operation receives the fixed-start exception", () => harness(async (h) => {
  await h.gateway();
  for (const params of [
    { action: "run", jobId: "other-job" }, { action: "add", job: { name: "fixture" } },
    { action: "create", job: {} }, { action: "update", job: {} }, { action: "remove" },
    { action: "wake", text: "fixture" }, { action: "next_check", in: "5m" },
    { jobId: JOB, id: "conflicting-job" }, { jobId: " " + JOB },
    { runMode: "invalid" }, { timeoutMs: -1 }, { timeoutMs: 9999999 },
    { gatewayUrl: "https://remote.invalid" }, { gatewayToken: "fixture" },
    { job: { payload: { kind: "agentTurn", message: "replacement" } } }, { agentId: "other" }, { runId: "chosen" }
  ]) assert.notEqual((await h.policy.evaluate(runEvent(params), owner)).allow, true, JSON.stringify(params));
}));

test("fixed start recognizes the exact legacy id alias and due mode", () => harness(async (h) => {
  await h.gateway();
  const event = { toolName: "cron", toolCallId: "legacy", params: { action: "run", id: JOB } };
  assert.equal((await h.policy.evaluate(event, owner)).allow, true);
}));

test("disabled, missing, wrong-agent or replaced Gateway jobs cannot use this exception", () => harness(async (h) => {
  await h.gateway(); const original = h.jobs[0];
  for (const changed of [[], [{ ...original, enabled: false }], [{ ...original, agentId: "other" }], [{ ...original, payload: { kind: "command" } }], [{ ...original, sessionTarget: "main" }], [original, original]]) {
    h.jobs = changed; assert.notEqual((await h.policy.evaluate(runEvent(), owner)).allow, true);
  }
}));

test("duplicate tool-call IDs, aliases and modes cannot enqueue twice within one owner turn", () => harness(async (h) => {
  await h.gateway(); assert.equal((await h.policy.evaluate(runEvent(), owner)).allow, true);
  for (const event of [runEvent({}, "another-call"), runEvent({ runMode: "due" }, "due"), { toolName: "automations", toolCallId: "alias", params: { action: "run", id: JOB } }]) {
    const result = await h.policy.evaluate(event, owner); assert.equal(result.allow, false); assert.match(result.reason, /FIXED_CRON_START_DUPLICATE/);
  }
  assert.equal((await h.policy.evaluate(runEvent(), { ...owner, runId: "new-owner-turn" })).allow, true);
}));

test("Gateway shutdown or superseded context revokes manual-start observation", () => harness(async (h) => {
  await h.gateway(); await h.hooks.get("gateway_stop")({}, {});
  assert.notEqual((await h.policy.evaluate(runEvent(), owner)).allow, true);
  const abort = new AbortController();
  await h.hooks.get("cron_reconciled")({}, { getCron: () => ({ list: async () => h.jobs }), abortSignal: abort.signal }); abort.abort();
  assert.notEqual((await h.policy.evaluate(runEvent(), owner)).allow, true);
}));

test("same registered internal scope is reached from manual and scheduled launches with distinct IDs", () => harness(async (h) => {
  await h.gateway(); assert.equal((await h.policy.evaluate(runEvent(), owner)).allow, true);
  for (const [i, ctx] of [cronContext("manual-agent-run", "manual-session", "manual-scheduler"), cronContext("scheduled-agent-run", "scheduled-session", "scheduled-scheduler")].entries()) {
    await h.hooks.get("before_agent_run")({}, ctx);
    const toolCtx = { agentId: ctx.agentId, runId: ctx.runId, sessionId: ctx.sessionId, sessionKey: ctx.sessionKey };
    assert.equal((await h.policy.evaluate(writeEvent(`entry-${i}`), toolCtx)).allow, true);
    assert.notEqual((await h.policy.evaluate(writeEvent(`wrong-session-${i}`), { ...toolCtx, sessionId: "wrong" })).allow, true);
    await h.hooks.get("agent_end")({ success: true }, ctx);
  }
  assert.ok(h.logs.some((s) => s.includes('"source":"fixed-cron-rule"')));
  assert.equal(h.logs.some((s) => s.includes('"reason":"active grant not found"')), false);
}));

test("internal scope permits only the five tools and self notification", () => harness(async (h) => {
  const ctx = cronContext(); await h.hooks.get("before_agent_run")({}, ctx);
  assert.equal((await h.policy.evaluate({ toolName: "mcd-mcp__auto-bind-coupons", toolCallId: "coupons", params: {} }, ctx)).allow, true);
  const self = { toolName: "message", toolCallId: "self", params: { action: "send", channel: "telegram", target: process.env.TELEGRAM_USER_ID || "1000000", message: "fixture" } };
  assert.equal((await h.policy.evaluate(self, ctx)).allow, true);
  assert.notEqual((await h.policy.evaluate({ ...self, toolCallId: "other", params: { ...self.params, target: "12345" } }, ctx)).allow, true);
  for (const toolName of ["apply_patch", "edit", "sessions_spawn", "automations", "web_search"]) {
    assert.equal((await h.policy.evaluate({ toolName, toolCallId: toolName, params: { action: "run", jobId: JOB } }, ctx)).allow, false, toolName);
  }
}));

test("expired run authority cannot be renewed or replaced by same-session identity", () => harness(async (h) => {
  const store = new OperationStore(h.dbPath); store.open();
  try {
    const registry = new CronRunRegistry(store, { ttlMs: 10 });
    const ctx = cronContext(); const now = Date.now();
    assert.equal(registry.bindDirectGatewayCron(ctx, now).ok, true);
    assert.ok(registry.matchesDirectGatewayCron(ctx, undefined, now + 9));
    assert.equal(registry.matchesDirectGatewayCron(ctx, undefined, now + 10), null);
    assert.equal(registry.bindDirectGatewayCron(ctx, now + 10).ok, false);
    store.db.prepare("UPDATE trusted_cron_runs SET expires_at = ?").run(now - 1);
    assert.notEqual((await h.policy.evaluate(writeEvent(), ctx)).allow, true);
  } finally { store.close(); }
}));

test("completed or revoked authority cannot be reactivated by repeated launch hooks", () => harness(async (h) => {
  const store = new OperationStore(h.dbPath); store.open();
  try {
    const registry = new CronRunRegistry(store); const now = Date.now();
    for (const success of [true, false]) {
      const ctx = cronContext(`ended-${success}`);
      assert.equal(registry.bindDirectGatewayCron(ctx, now).ok, true);
      assert.equal(registry.finish(ctx, success, now + 1), 1);
      assert.equal(registry.bindDirectGatewayCron(ctx, now + 2).ok, false);
    }
    const ctx = cronContext("revoked");
    assert.equal(registry.bindDirectGatewayCron(ctx, now).ok, true);
    registry.invalidateJob(JOB, now + 1);
    assert.equal(registry.bindDirectGatewayCron(ctx, now + 2).ok, false);
  } finally { store.close(); }
}));

test("owner rejection is respected even after fixed-start proof becomes available", () => harness(async (h) => {
  const event = runEvent(); const pending = await h.policy.evaluate(event, owner);
  await pending.requireApproval.onResolution("deny"); await h.gateway();
  const decision = await h.policy.evaluate({ ...event, toolCallId: "retry" }, owner);
  assert.equal(decision.allow, false); assert.match(decision.reason, /USER_DENIED/);
}));

test("job update revokes an already registered run", () => harness(async (h) => {
  const ctx = cronContext(); await h.hooks.get("before_agent_run")({}, ctx);
  await h.hooks.get("cron_changed")({ action: "removed", jobId: JOB });
  assert.notEqual((await h.policy.evaluate(writeEvent(), ctx)).allow, true);
}));

test("failed child run or nonzero Shell result is audited as FAILED", () => harness(async (h) => {
  await h.gateway(); const event = runEvent();
  await h.policy.evaluate(event, owner);
  await h.hooks.get("after_tool_call")({ ...event, result: { details: { run: { status: "error" } } } }, owner);
  const ctx = cronContext(); await h.hooks.get("before_agent_run")({}, ctx); const write = writeEvent();
  await h.policy.evaluate(write, ctx);
  await h.hooks.get("after_tool_call")({ ...write, result: { details: { exitCode: 1 } } }, ctx);
  const store = new OperationStore(h.dbPath); store.open();
  try {
    const rows = store.db.prepare("SELECT details_json FROM audit_log WHERE event_type IN ('fixed_cron_start.completed','cron_approval_bypass.completed')").all();
    assert.equal(rows.length, 2); assert.ok(rows.every((r) => JSON.parse(r.details_json).resultStatus === "FAILED"));
  } finally { store.close(); }
}));

test("automations uses the same L4 mutation classification as legacy cron", () => {
  for (const toolName of ["cron", "automations"]) {
    for (const action of ["add", "update", "run", "remove", "wake"]) assert.equal(resolveCapability({ toolName, params: { action } }).riskLevel, "L4");
    for (const action of ["status", "list", "get", "runs"]) assert.equal(resolveCapability({ toolName, params: { action } }).riskLevel, "L0");
  }
});

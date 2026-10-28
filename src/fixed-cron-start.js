import { paramsHash } from "./canonical-json.js";

const FIELDS = new Set(["action", "jobId", "id", "runMode", "timeoutMs"]);
const DELEGATION = ["delegatedByAgentId", "delegatedBy", "parentAgentId", "parentAgent", "parentRunId", "parentSessionKey", "requesterSessionKey", "requesterAgentId"];
const exact = (value) => typeof value === "string" && value.length > 0 && value === value.trim();

// Tool arguments select an existing job; they never prove identity or create
// authority. Identity is host requester metadata, scope is the existing fixed
// rule, and existence/enabled/agent are read from the live Gateway service.
export async function findFixedCronStart({ rules, event, ctx = {}, getCron }) {
  if (!["automations", "cron"].includes(event?.toolName) || (ctx.toolName !== undefined && ctx.toolName !== event.toolName)) return null;
  if (ctx.abortSignal?.aborted) return null;
  const params = event?.params;
  if (!params || params.action !== "run" || Object.keys(params).some((name) => !FIELDS.has(name))) return null;
  const id = params.jobId ?? params.id;
  if (!exact(id) || (params.jobId !== undefined && params.id !== undefined && params.jobId !== params.id)) return null;
  if (params.runMode !== undefined && !["due", "force"].includes(params.runMode)) return null;
  if (params.timeoutMs !== undefined && (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs < 1 || params.timeoutMs > 300_000)) return null;
  if (![ctx.agentId, ctx.runId, ctx.sessionKey, ctx.sessionId].every(exact) || !ctx.sessionKey.startsWith(`agent:${ctx.agentId}:`) || /:cron:/.test(ctx.sessionKey) || DELEGATION.some((name) => ctx[name])) return null;
  const requester = ctx.requester;
  if (requester?.senderIsOwner !== true || requester.channel !== "telegram" || !exact(requester.senderId)) return null;
  const rule = (rules || []).find((candidate) => candidate.agentId === ctx.agentId && candidate.jobIds.includes(id));
  if (!rule) return null;
  let jobs;
  try {
    const cron = getCron?.();
    if (typeof cron?.list !== "function") return null;
    jobs = await cron.list({ includeDisabled: true });
  } catch { return null; }
  if (!Array.isArray(jobs)) return null;
  const matches = jobs.filter((job) => job?.id === id);
  if (matches.length !== 1) return null;
  const job = matches[0];
  if (job.enabled !== true || job.agentId !== rule.agentId || job.sessionTarget !== "isolated" || job.payload?.kind !== "agentTurn") return null;
  return {
    rule, cronJobId: id, agentId: ctx.agentId, runId: ctx.runId, sessionKey: ctx.sessionKey, sessionId: ctx.sessionId,
    canonicalHash: `sha256:${paramsHash(params)}`,
    // A changed tool-call ID or due/force variant cannot enqueue this same
    // fixed job twice within one requesting turn. A new owner turn is distinct.
    effectKey: `fixed-cron-start:${paramsHash({ agentId: ctx.agentId, runId: ctx.runId, sessionKey: ctx.sessionKey, sessionId: ctx.sessionId, cronJobId: id, channel: requester.channel, accountId: requester.accountId || "default", senderId: requester.senderId })}`
  };
}

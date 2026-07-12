import { canonicalDestinationIdentity, destinationKey } from "./destination-identity.js";
import { sha256Hex, stableStringify } from "./canonical-json.js";
import { resolveExecEffect } from "./exec-effect-resolver.js";
import { BENEFITS_PARENT_CRON_JOB_ID, MEITUAN_CRON_JOB_ID, OPENCLAW_WORKSPACE, OWNER_TELEGRAM_ID, REM_CRON_JOB_ID, openclawPath, resolveAgentIds } from "./template-config.js";

const OWNER_ID = `telegram:${OWNER_TELEGRAM_ID}`;
const OWNER_DESTINATION = {
  channel: "telegram",
  account_id: "default",
  recipient_type: "user",
  recipient_id: OWNER_TELEGRAM_ID
};
const REM_READ_DISCOVERY_COMMANDS = [
  `find ${OPENCLAW_WORKSPACE}/memory/topics -type f`,
  `find ${OPENCLAW_WORKSPACE}/memory/.learnings -type f`,
  `find ${OPENCLAW_WORKSPACE}/topics -type f`,
  `find ${OPENCLAW_WORKSPACE}/.learnings -type f`
];
const MEITUAN_FIXED_COMMANDS = [
  `python3 ${openclawPath("skills", "meituan-coupon", "scripts", "auth.py")} token-verify`,
  `python3 ${openclawPath("skills", "meituan-coupon", "scripts", "issue.py")} --token TOKEN_VALUE --phone-masked PHONE_MASKED_VALUE`
];

const HIGH_RISK_CAPABILITIES = new Set([
  "PAYMENT",
  "CREATE_ORDER",
  "SEND_THIRD_PARTY_MESSAGE",
  "CONFIG_MUTATION",
  "CRON_MUTATION",
  "DELETE",
  "ARBITRARY_EXEC"
]);

export function buildAutomationGrantFromCron(job, now = Date.now(), agentConfig = {}) {
  const normalized = canonicalCronDefinition(job);
  const automationSpecHash = sha256Hex(stableStringify(normalized));
  const scope = inferScope(job, agentConfig);
  const authorizationScopeHash = sha256Hex(stableStringify(scope));
  const review = reviewRequired(scope);
  return {
    grantId: `grant_${job.id}`,
    ownerId: OWNER_ID,
    automationId: `cron:${job.id}`,
    cronJobId: job.id,
    agentId: job.agentId || resolveAgentIds(agentConfig).rem,
    automationSpecHash,
    authorizationScopeHash,
    grantVersion: 1,
    grantHash: sha256Hex(stableStringify({ automationSpecHash, authorizationScopeHash })),
    status: review.required ? "REVIEW_REQUIRED" : "ACTIVE",
    allowedCapabilities: scope.capabilities,
    allowedTools: scope.tools,
    allowedResources: scope.resources,
    allowedDestinations: scope.destinations,
    exactExecCommands: scope.exactExecCommands,
    maxRunsPerPeriod: maxRunsPerDay(job, agentConfig),
    periodKind: "day",
    reviewReason: review.reason,
    sourceJobJson: normalized,
    createdAt: now,
    updatedAt: now
  };
}

export function canonicalCronDefinition(job) {
  return {
    id: job.id,
    name: job.name || "",
    enabled: job.enabled === true,
    agentId: job.agentId || "",
    sessionKey: job.sessionKey || "",
    schedule: job.schedule || {},
    sessionTarget: job.sessionTarget || "",
    wakeMode: job.wakeMode || "",
    payload: job.payload || {},
    delivery: job.delivery || {},
    failureAlert: job.failureAlert || null
  };
}

export function inferScope(job, agentConfig = {}) {
  const agentIds = resolveAgentIds(agentConfig);
  const text = cronText(job);
  const lower = text.toLowerCase();
  const capabilities = new Set(["READ_WORKSPACE_SAFE"]);
  const tools = new Set(["read", "dir_list"]);
  const resources = new Set(["workspace:safe-read"]);
  const destinations = new Set();
  const exactExecCommands = new Set();

  const delivery = job.delivery || {};
  const destination = canonicalDestinationIdentity({
    channel: delivery.channel,
    accountId: delivery.accountId || "default",
    target: delivery.to
  });
  if (destination.ok && sameOwnerDestination(destination.identity)) {
    capabilities.add("SEND_SELF_NOTIFICATION");
    destinations.add(destinationKey(destination.identity));
  } else if (delivery.to) {
    capabilities.add("SEND_THIRD_PARTY_MESSAGE");
  }

  const isMeituanCouponJob = job.id === MEITUAN_CRON_JOB_ID && job.agentId === agentIds.meituan;
  const isMcdCouponJob = /mcd-mcp__|麦当劳/i.test(text);
  const isBenefitsParent = job.id === BENEFITS_PARENT_CRON_JOB_ID && job.agentId === agentIds.benefits;
  if (isBenefitsParent) {
    capabilities.add("MEITUAN_QUERY_COUPON");
    capabilities.add("MEITUAN_CLAIM_COUPON");
    capabilities.add("MCDONALDS_QUERY_COUPON");
    capabilities.add("MCDONALDS_CLAIM_COUPON");
    tools.add("exec");
    tools.add("mcd-mcp__available-coupons");
    tools.add("mcd-mcp__auto-bind-coupons");
    tools.add("mcd-mcp__query-my-account");
    resources.add("mcdonalds:coupon:own");
    for (const command of MEITUAN_FIXED_COMMANDS) {
      const effect = resolveExecEffect({ command });
      resources.add(effect.resourceKey);
      if (effect.capability === "MEITUAN_QUERY_COUPON") exactExecCommands.add(command);
    }
  } else if (isMeituanCouponJob) {
    capabilities.add("MEITUAN_QUERY_COUPON");
    capabilities.add("MEITUAN_CLAIM_COUPON");
    tools.add("exec");
    for (const command of MEITUAN_FIXED_COMMANDS) {
      const effect = resolveExecEffect({ command });
      if (effect.capability === "MEITUAN_QUERY_COUPON" || effect.capability === "MEITUAN_CLAIM_COUPON") {
        resources.add(effect.resourceKey);
      }
      if (effect.capability === "MEITUAN_QUERY_COUPON") exactExecCommands.add(command);
    }
  } else if (isMcdCouponJob) {
    capabilities.add("MCDONALDS_QUERY_COUPON");
    capabilities.add("MCDONALDS_CLAIM_COUPON");
    tools.add("mcd-mcp__available-coupons");
    tools.add("mcd-mcp__auto-bind-coupons");
    tools.add("mcd-mcp__query-my-account");
    resources.add("mcdonalds:coupon:own");
  } else if (/coupon|优惠券|领券|auto-bind-coupons|available-coupons|券/i.test(text)) {
    capabilities.add("QUERY_EXTERNAL");
    capabilities.add("CLAIM_COUPON");
    tools.add("mcd-mcp__available-coupons");
    tools.add("mcd-mcp__auto-bind-coupons");
    tools.add("mcd-mcp__query-my-account");
    resources.add("coupon:*");
  }
  if (/weather|天气|news|新闻|scan|扫描|查询|读取|meter|电表|电费|积分|account/i.test(text)) {
    capabilities.add("QUERY_EXTERNAL");
  }
  if (/写入|记录|dailyHistory|monthlyHistory|Baseline|memory\/|electricity-usage\.json/i.test(text)) {
    capabilities.add("WRITE_WORKSPACE_STATE");
    resources.add("workspace-state:own");
  }
  const isRemMemoryScan = job.id === REM_CRON_JOB_ID && job.agentId === agentIds.rem;
  if (isRemMemoryScan) {
    capabilities.add("WRITE_OWN_MEMORY_STATE");
    tools.add("write");
    tools.add("edit");
    tools.add("apply_patch");
    resources.add("memory-state:own");
    tools.add("exec");
    for (const command of REM_READ_DISCOVERY_COMMANDS) exactExecCommands.add(command);
  }
  if (/create[-_ ]?order|下单|订单|mall-create-order/i.test(lower)) {
    capabilities.add("CREATE_ORDER");
  }
  if (/payment|支付|付款|payh5url|payurl|二维码/i.test(lower)) {
    capabilities.add("PAYMENT");
  }
  if (/config\.|gateway|openclaw update|cron\s+(add|edit|enable|disable|rm)|配置/i.test(lower)) {
    capabilities.add("CONFIG_MUTATION");
  }
  for (const command of isRemMemoryScan || isMeituanCouponJob || isBenefitsParent ? [] : extractDeclaredExecCommands(text)) {
    exactExecCommands.add(command);
    tools.add("exec");
    const effect = resolveExecEffect({ command });
    capabilities.add(effect.capability);
    if (effect.resourceKey) {
      resources.add(effect.resourceKey);
    } else {
      resources.add(`exec:${sha256Hex(stableStringify({ command }))}`);
    }
  }
  if (!isRemMemoryScan && exactExecCommands.size === 0 && /执行命令|`[^`]*(python3|openclaw|node|bash|sh)\b/i.test(text)) {
    capabilities.add("ARBITRARY_EXEC");
  }
  if (isRemMemoryScan) {
    capabilities.delete("QUERY_EXTERNAL");
    capabilities.delete("WRITE_WORKSPACE_STATE");
    resources.delete("workspace-state:own");
  }
  if (isMeituanCouponJob) {
    capabilities.delete("QUERY_EXTERNAL");
  }
  if (isMcdCouponJob) {
    capabilities.delete("QUERY_EXTERNAL");
  }
  if (isBenefitsParent) {
    capabilities.delete("QUERY_EXTERNAL");
    capabilities.delete("CREATE_ORDER");
    capabilities.delete("PAYMENT");
    capabilities.delete("WRITE_WORKSPACE_STATE");
    resources.delete("workspace-state:own");
  }

  return {
    capabilities: [...capabilities].sort(),
    tools: [...tools].sort(),
    resources: [...resources].sort(),
    destinations: [...destinations].sort(),
    exactExecCommands: [...exactExecCommands].sort()
  };
}

export function isScopeSubset(candidate, base) {
  return ["capabilities", "tools", "resources", "destinations"].every((key) => {
    const baseSet = new Set(base?.[key] || []);
    return (candidate?.[key] || []).every((value) => baseSet.has(value));
  });
}

export function intersectScopes(parent, requested) {
  const fallback = {
    capabilities: ["READ_WORKSPACE_SAFE"],
    tools: ["read", "dir_list"],
    resources: ["workspace:safe-read"],
    destinations: []
  };
  const child = requested || fallback;
  const result = {};
  for (const key of ["capabilities", "tools", "resources", "destinations"]) {
    const parentSet = new Set(parent?.[key] || []);
    result[key] = (child[key] || []).filter((value) => parentSet.has(value)).sort();
  }
  return result;
}

function reviewRequired(scope) {
  for (const capability of scope.capabilities) {
    if (HIGH_RISK_CAPABILITIES.has(capability)) {
      return { required: true, reason: `high risk capability ${capability}` };
    }
  }
  return { required: false, reason: "" };
}

function maxRunsPerDay(job, agentConfig = {}) {
  if (job.id === REM_CRON_JOB_ID && job.agentId === resolveAgentIds(agentConfig).rem) return 12;
  const schedule = job.schedule || {};
  if (schedule.kind === "every" && schedule.everyMs) {
    return Math.max(1, Math.ceil(86_400_000 / Number(schedule.everyMs)));
  }
  return 3;
}

function cronText(job) {
  return stableStringify({
    name: job.name || "",
    description: job.description || "",
    payload: job.payload || {},
    delivery: job.delivery || {}
  });
}

function extractDeclaredExecCommands(text) {
  const commands = [];
  const patterns = [
    /执行命令[:：]\s*([^\n`]+)/gi,
    /`([^`]*(?:python3|openclaw|node|bash|sh)\s+[^`]*)`/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const command = String(match[1] || "").trim();
      if (command && !/[“”"'].*USER_TOKEN|PHONE_MASKED/.test(command)) {
        commands.push(command);
      }
    }
  }
  return [...new Set(commands)];
}

function sameOwnerDestination(identity) {
  return destinationKey(identity) === destinationKey(OWNER_DESTINATION);
}

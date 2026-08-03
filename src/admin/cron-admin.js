const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DANGEROUS_KEY = /(?:command|shell|exec(?:utable)?|webhook|env(?:ironment)?|token|secret|password|authorization|cookie|path|file)/i;
const DANGEROUS_VALUE = /(?:\b(?:bash|sh|zsh|node|python(?:3)?|curl|wget)\b|\$\{|`|;|&&|\|\|)/i;

export function cronJobId(value) {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("CRON_CONFIG_ERROR: cron id is invalid");
  return value;
}

export function cronCreateArgs(spec) {
  assertObject(spec, "spec");
  assertKeys(spec, ["name", "schedule", "task", "agentId", "enabled"], "spec");
  if (typeof spec.name !== "string" || !spec.name.trim() || spec.name.length > 120) throw new Error("CRON_CONFIG_ERROR: name is required and must be at most 120 characters");
  if (typeof spec.agentId !== "string" || !ID.test(spec.agentId)) throw new Error("CRON_CONFIG_ERROR: agentId is invalid");
  if (spec.enabled !== undefined && spec.enabled !== false) throw new Error("CRON_SCOPE_DENIED: local create must begin disabled");
  const schedule = readSchedule(spec.schedule);
  const message = readTask(spec.task);
  return ["add", "--name", spec.name.trim(), "--cron", schedule.expression, "--tz", schedule.timezone, "--agent", spec.agentId, "--session", "isolated", "--message", message, "--disabled"];
}

export function cronUpdateArgs(id, patch) {
  cronJobId(id);
  assertObject(patch, "patch");
  assertKeys(patch, ["schedule", "task"], "patch");
  if (!patch.schedule && !patch.task) throw new Error("CRON_CONFIG_ERROR: patch must contain schedule or task");
  const args = ["edit", id];
  if (patch.schedule) {
    const schedule = readSchedule(patch.schedule);
    args.push("--cron", schedule.expression, "--tz", schedule.timezone);
  }
  if (patch.task) args.push("--message", readTask(patch.task));
  return args;
}

export function cronActionArgs(action, id) {
  cronJobId(id);
  const command = { enable: "enable", disable: "disable", delete: "rm" }[action];
  if (!command) throw new Error("CRON_CONFIG_ERROR: unsupported cron action");
  return [command, id];
}

function readSchedule(value) {
  assertObject(value, "schedule");
  assertKeys(value, ["type", "expression", "timezone"], "schedule");
  if (value.type !== "cron" || typeof value.expression !== "string" || !validCron(value.expression)) throw new Error("CRON_CONFIG_ERROR: schedule must be a five-field cron expression");
  if (typeof value.timezone !== "string" || !/^[A-Za-z_]+(?:\/[A-Za-z_+-]+)+$/.test(value.timezone)) throw new Error("CRON_CONFIG_ERROR: timezone must be an IANA name");
  return { expression: value.expression.trim(), timezone: value.timezone };
}

function readTask(value) {
  assertObject(value, "task");
  assertKeys(value, ["type", "message"], "task");
  if (value.type !== "agentTurn" || typeof value.message !== "string" || !value.message.trim() || value.message.length > 2000) throw new Error("CRON_CONFIG_ERROR: task must be a bounded agentTurn message");
  if (DANGEROUS_VALUE.test(value.message)) throw new Error("CRON_SCOPE_DENIED: task message contains dynamic execution syntax");
  return value.message;
}

function validCron(value) { return value.trim().split(/\s+/).length === 5 && !/[\r\n]/.test(value); }
function assertObject(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`CRON_CONFIG_ERROR: ${label} must be an object`); }
function assertKeys(value, allowed, label) { for (const key of Object.keys(value)) if (!allowed.includes(key) || DANGEROUS_KEY.test(key)) throw new Error(`CRON_SCOPE_DENIED: ${label}.${key} is not permitted`); }

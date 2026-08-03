import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { EXECUTION_GATE_HOME, NODE_EXECUTABLE, OPENCLAW_HOME, OPENCLAW_STATE, OPENCLAW_WORKSPACE, OWNER_TELEGRAM_ID, PYTHON_EXECUTABLE, gatePath } from "./template-config.js";

export const SKILL_REGISTRY_PATH = resolve(OPENCLAW_STATE, "skill-registry.json");
const OWNER_TELEGRAM_CONTEXT = new RegExp(`(?:^telegram:${OWNER_TELEGRAM_ID}$|agent:main:telegram:direct:${OWNER_TELEGRAM_ID})`);

export function readSkillRegistry(path = SKILL_REGISTRY_PATH) {
  if (!existsSync(path)) return { schemaVersion: 1, skills: [] };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.skills)) return { schemaVersion: 1, skills: [], invalid: true };
    return value;
  } catch {
    return { schemaVersion: 1, skills: [], invalid: true };
  }
}

export function matchRegisteredSkillExec({ argv = [], params = {}, ctx = {}, registry = readSkillRegistry() } = {}) {
  if (!Array.isArray(argv) || argv.length < 1 || registry.invalid) return null;
  const normalizedArgv = [...argv];
  if (!String(normalizedArgv[0]).startsWith("/") && ["python3", "python", "node", "nodejs"].includes(normalizedArgv[0])) {
    const candidate = normalizedArgv[0].startsWith("python") ? PYTHON_EXECUTABLE : NODE_EXECUTABLE;
    try { normalizedArgv[0] = realpathSync(candidate); } catch { return null; }
  }
  for (const skill of registry.skills || []) {
    if (!skill?.enabled || !exactArray([skill.entry?.executable, ...(skill.entry?.argv || [])], normalizedArgv)) continue;
    if (!executionParamsMatch(skill, params)) continue;
    if (!scopeMatches(skill, ctx)) continue;
    return skill;
  }
  return null;
}

export function registrySkillEffect(skill) {
  return {
    capability: skill.capability.name,
    riskLevel: skill.capability.riskLevel,
    operationType: `registered-skill:${skill.skillId}`,
    reason: `registered skill ${skill.skillId}`,
    resourceKey: `registered-skill:${skill.skillId}`,
    registeredSkill: true,
    skillId: skill.skillId,
    skillExecution: skill.execution || {},
    skillSnapshotHash: skill.manifestHash || ""
  };
}

export function scopeMatches(skill, ctx = {}) {
  const agentId = String(ctx.agentId || "");
  if (!Array.isArray(skill.agents) || !skill.agents.includes(agentId)) return false;
  const channels = skill.invocation?.channels || [];
  if (channels.length > 0 && !channels.includes(channelFromContext(ctx))) return false;
  const actors = skill.invocation?.actors || [];
  if (actors.length === 0) return true;
  return actors.some((actor) => actorMatches(actor, ctx));
}

export function isManifestPathAllowed(path) {
  const value = String(path || "");
  let candidate;
  try { candidate = existsSync(value) ? realpathSync(value) : resolve(value); } catch { return false; }
  if (candidate === gatePath("bin", "openclaw-trusted-exec.mjs")) return true;
  const roots = [OPENCLAW_WORKSPACE, resolve(OPENCLAW_HOME, "skills")];
  return roots.some((root) => {
    const rel = relative(root, candidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function channelFromContext(ctx) {
  const raw = String(ctx.channel || ctx.messageProvider || ctx.channelId || ctx.sessionKey || "");
  if (/telegram/i.test(raw)) return "telegram";
  if (/discord/i.test(raw)) return "discord";
  if (/slack/i.test(raw)) return "slack";
  return "local";
}

function actorMatches(actor, ctx) {
  if (actor === "owner-telegram") {
    return ctx.agentId === "main" && (
      OWNER_TELEGRAM_CONTEXT.test(String(ctx.channelId || "")) ||
      OWNER_TELEGRAM_CONTEXT.test(String(ctx.sessionKey || ""))
    );
  }
  return false;
}

function executionParamsMatch(skill, params) {
  const input = params && typeof params === "object" ? params : {};
  for (const key of ["cwd", "workingDirectory"]) {
    if (Object.hasOwn(input, key) && canonicalPath(input[key]) !== skill.entry?.cwd) return false;
  }
  for (const key of ["timeout", "timeoutSeconds"]) {
    if (!Object.hasOwn(input, key)) continue;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value <= 0 || value > Number(skill.constraints?.timeoutSeconds || 0)) return false;
  }
  return !["env", "environment", "envVars"].some((key) => Object.hasOwn(input, key) && input[key] !== undefined && input[key] !== null && Object.keys(input[key] || {}).length !== 0);
}

function canonicalPath(value) {
  try { return realpathSync(value); } catch { return resolve(value); }
}

function exactArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

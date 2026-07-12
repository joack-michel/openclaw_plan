import { homedir } from "node:os";
import { resolve } from "node:path";

export const OPENCLAW_HOME = resolve(expandHome(process.env.OPENCLAW_HOME || "~/.openclaw"));
export const OPENCLAW_WORKSPACE = resolve(expandHome(process.env.OPENCLAW_WORKSPACE || "~/.openclaw/workspace"));
export const EXECUTION_GATE_HOME = resolve(expandHome(process.env.EXECUTION_GATE_HOME || "~/openclaw-execution-gate"));
export const OWNER_TELEGRAM_ID = String(process.env.TELEGRAM_USER_ID || "example-owner");
export const DEFAULT_AGENT_IDS = Object.freeze({
  benefits: "benefits-orchestrator",
  rem: "memory-agent",
  meituan: "commerce-agent",
  mcdonalds: "commerce-agent"
});

// Fictional defaults are safe fixtures. Production deployments should set
// these values in private-overlay/.env.
export const REM_CRON_JOB_ID = String(process.env.REM_CRON_JOB_ID || "<REM_CRON_JOB_ID>");
export const MEITUAN_CRON_JOB_ID = String(process.env.MEITUAN_CRON_JOB_ID || "<MEITUAN_CRON_JOB_ID>");
export const BENEFITS_PARENT_CRON_JOB_ID = String(process.env.BENEFITS_PARENT_CRON_JOB_ID || "<BENEFITS_PARENT_CRON_JOB_ID>");

export const ACCESS_CONTROL = Object.freeze({
  enabled: process.env.ACCESS_CONTROL_ENABLED === "true",
  scope: String(process.env.ACCESS_CONTROL_SCOPE || "example-community:building-a:unit-1:door-open"),
  command: String(process.env.ACCESS_CONTROL_COMMAND || "")
});

export function workspacePath(...parts) {
  return resolve(OPENCLAW_WORKSPACE, ...parts);
}

export function openclawPath(...parts) {
  return resolve(OPENCLAW_HOME, ...parts);
}

// Explicit plugin configuration has priority over environment values, followed
// by public template defaults. This function never reads an instance config.
export function resolveAgentIds(config = {}) {
  const source = config && typeof config === "object" ? config : {};
  const configured = source.agentIds && typeof source.agentIds === "object" ? source.agentIds : {};
  return Object.freeze({
    benefits: agentId(configured.benefits, process.env.BENEFITS_AGENT_ID, DEFAULT_AGENT_IDS.benefits),
    rem: agentId(configured.rem, process.env.REM_AGENT_ID, DEFAULT_AGENT_IDS.rem),
    meituan: agentId(configured.meituan, process.env.MEITUAN_AGENT_ID, DEFAULT_AGENT_IDS.meituan),
    mcdonalds: agentId(configured.mcdonalds, process.env.MCDONALDS_AGENT_ID, DEFAULT_AGENT_IDS.mcdonalds)
  });
}

function agentId(...values) {
  return String(values.find((value) => typeof value === "string" && value.trim()) || "").trim();
}

function expandHome(value) {
  return String(value).startsWith("~/") ? resolve(homedir(), String(value).slice(2)) : String(value);
}

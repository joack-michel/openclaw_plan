import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function expandHome(value) {
  const text = String(value || "");
  return text.startsWith("~/") ? resolve(homedir(), text.slice(2)) : resolve(text);
}

export const OPENCLAW_HOME = expandHome(process.env.OPENCLAW_HOME || "~/.openclaw");
export const OPENCLAW_WORKSPACE = expandHome(process.env.OPENCLAW_WORKSPACE || "~/.openclaw/workspace");
const MODULE_GATE_HOME = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EXECUTION_GATE_HOME = expandHome(process.env.EXECUTION_GATE_HOME || MODULE_GATE_HOME);
export const OPENCLAW_STATE = resolve(OPENCLAW_HOME, "state");
export const USER_HOME = dirname(OPENCLAW_HOME);
export const NODE_EXECUTABLE = String(process.env.NODE_EXECUTABLE || process.execPath);
export const PYTHON_EXECUTABLE = String(process.env.PYTHON_EXECUTABLE || "/usr/bin/python3");
export const NUMBER_CLI = String(process.env.NUMBER_CLI || resolve(USER_HOME, ".local/bin/number"));

export const OWNER_TELEGRAM_ID = String(process.env.TELEGRAM_USER_ID || "1000000");
export const OWNER_ID = `telegram:${OWNER_TELEGRAM_ID}`;

export const DEFAULT_AGENT_IDS = Object.freeze({
  benefits: String(process.env.BENEFITS_AGENT_ID || "benefits-orchestrator"),
  rem: String(process.env.REM_AGENT_ID || "main"),
  meituan: String(process.env.MEITUAN_AGENT_ID || "main"),
  mcdonalds: String(process.env.MCDONALDS_AGENT_ID || "main")
});

export const REM_CRON_JOB_ID = String(process.env.REM_CRON_JOB_ID || "rem-job");
export const MEITUAN_CRON_JOB_ID = String(process.env.MEITUAN_CRON_JOB_ID || "meituan-job");
export const BENEFITS_PARENT_CRON_JOB_ID = String(process.env.BENEFITS_PARENT_CRON_JOB_ID || "benefits-job");

export function workspacePath(...parts) { return resolve(OPENCLAW_WORKSPACE, ...parts); }
export function openclawPath(...parts) { return resolve(OPENCLAW_HOME, ...parts); }
export function gatePath(...parts) { return resolve(EXECUTION_GATE_HOME, ...parts); }

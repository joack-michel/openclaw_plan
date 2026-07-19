import { spawnSync } from "node:child_process";
import { CONFIG_PATH, STATE_DIR } from "./admin/local-admin.js";

export function runMcpCli(argv) {
  const result = spawnSync("openclaw", ["mcp", ...argv], {
    encoding: "utf8",
    shell: false,
    env: { ...process.env, OPENCLAW_STATE_DIR: STATE_DIR, OPENCLAW_CONFIG_PATH: CONFIG_PATH }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(redact(result.stderr || result.stdout || `openclaw mcp exited ${result.status}`));
  return { stdout: redact(result.stdout), stderr: redact(result.stderr) };
}

export function runConfigValidate() {
  const result = spawnSync("openclaw", ["config", "validate", "--json"], {
    encoding: "utf8",
    shell: false,
    env: { ...process.env, OPENCLAW_STATE_DIR: STATE_DIR, OPENCLAW_CONFIG_PATH: CONFIG_PATH }
  });
  if (result.status !== 0) throw new Error(redact(result.stderr || result.stdout || "config validation failed"));
  return redact(result.stdout);
}

export function redact(value) {
  return String(value || "")
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)\S+/gi, "$1[REDACTED]")
    .replace(/(token|cookie|secret|password|api[_-]?key)\s*[=:]\s*[^\s,}\]]+/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/[^\s/]+/gi, "<MCP_ENDPOINT>");
}

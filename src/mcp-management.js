import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, OPENCLAW_HOME, withAdminLock } from "./admin/local-admin.js";
import { runConfigValidate, runMcpCli } from "./mcp-cli-adapter.js";

export function executeMcpRequest(request) {
  if (["list", "status"].includes(request.action)) return runMcpCli([request.action, "--json"]);
  if (["show", "doctor", "probe"].includes(request.action)) return runMcpCli([request.action, ...(request.name ? [request.name] : []), "--json"]);
  return withAdminLock(() => executeMutation(request));
}

function executeMutation(request) {
  const backupPath = backupConfig(request.action);
  try {
    if (["add", "update"].includes(request.action)) {
      runMcpCli(["set", request.name, JSON.stringify(toServerConfig(request))]);
      runConfigValidate();
      runMcpCli(["reload"]);
      const doctor = runMcpCli(["doctor", request.name, "--json"]);
      const probe = request.probe ? runMcpCli(["probe", request.name, "--json"]) : null;
      return { backupCreated: true, doctor: doctor.stdout, probe: probe?.stdout || null };
    }
    if (request.action === "remove") runMcpCli(["unset", request.name]);
    if (["enable", "disable"].includes(request.action)) runMcpCli(["configure", request.name, request.action === "enable" ? "--enable" : "--disable"]);
    if (request.action === "login") return { backupCreated: false, interaction: "OAUTH_INTERACTION_REQUIRED" };
    if (request.action === "logout") return { backupCreated: false, result: runMcpCli(["logout", request.name]).stdout };
    runConfigValidate();
    runMcpCli(["reload"]);
    return { backupCreated: true, doctor: runMcpCli(["doctor", request.name, "--json"]).stdout };
  } catch (error) {
    if (backupPath) copyFileSync(backupPath, CONFIG_PATH);
    throw error;
  }
}

function toServerConfig(request) {
  const base = {
    enabled: request.enabled,
    ...(request.transport === "streamable-http"
      ? { transport: request.transport, url: request.url }
      : { command: request.argv[0], args: request.argv.slice(1) })
  };
  if (request.auth.type === "oauth") {
    base.auth = "oauth";
    if (request.auth.scopes.length) base.oauth = { scope: request.auth.scopes.join(" ") };
  }
  if (request.auth.type === "bearer-env") base.headers = { Authorization: `Bearer \${${request.auth.env}}` };
  return base;
}

function backupConfig(action) {
  if (!existsSync(CONFIG_PATH)) throw new Error("OpenClaw config missing");
  const dir = join(OPENCLAW_HOME, "state", "openclaw-mcp-backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${action}-${Date.now()}.json`);
  copyFileSync(CONFIG_PATH, path);
  return path;
}

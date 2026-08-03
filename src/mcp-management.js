import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, OPENCLAW_HOME, withAdminLock } from "./admin/local-admin.js";
import { normalizeExistingMcpAuth } from "./mcp-schema.js";
import { runConfigValidate, runMcpCli } from "./mcp-cli-adapter.js";

export function executeMcpRequest(request) {
  if (["list", "status"].includes(request.action)) return runMcpCli([request.action, "--json"]);
  if (request.action === "doctor") return runMcpCli(["doctor", ...(request.name ? [request.name] : []), "--json"]);
  if (["show", "probe"].includes(request.action)) return runMcpCli([request.action, request.name, "--json"]);
  return withAdminLock(() => executeMutation(request));
}

// Used by one already-confirmed composite operation.  The installer never
// invokes the admin CLI itself: it reuses this same validated MCP mutation
// implementation and receives one backup, validation, and reload boundary.
export function executeMcpMutations(requests) {
  if (!Array.isArray(requests) || !requests.length) return { doctor: [] };
  return withAdminLock(() => {
    const backup = backupConfig("skill-install");
    try {
      for (const request of requests) executeMutationStep(request);
      runConfigValidate();
      runMcpCli(["reload"]);
      return { backup, doctor: requests.map((request) => runMcpCli(["doctor", request.name, "--json"]).stdout) };
    } catch (error) {
      copyFileSync(backup, CONFIG_PATH);
      try { runConfigValidate(); runMcpCli(["reload"]); } catch { /* preserve original failure */ }
      throw error;
    }
  });
}
function executeMutation(request) {
  if (request.action === "login") return { interaction: "OAUTH_INTERACTION_REQUIRED: complete the existing OAuth login locally; chat never accepts authorization codes or tokens." };
  const backup = backupConfig(request.action);
  try {
    executeMutationStep(request);
    runConfigValidate(); runMcpCli(["reload"]);
    return { backup, doctor: runMcpCli(["doctor", request.name, "--json"]).stdout, ...(request.probe ? { probe: runMcpCli(["probe", request.name, "--json"]).stdout } : {}) };
  } catch (error) { if (backup) copyFileSync(backup, CONFIG_PATH); throw error; }
}

function executeMutationStep(request) {
  if (["add", "update"].includes(request.action)) {
    const existing = request.action === "update" ? existingServer(request.name) : {};
    const server = applyMcpPatch(existing, request, request.action === "add");
    runMcpCli(["set", request.name, JSON.stringify(server)]);
  } else if (request.action === "remove") runMcpCli(["unset", request.name]);
  else if (["enable", "disable"].includes(request.action)) runMcpCli(["configure", request.name, request.action === "enable" ? "--enable" : "--disable"]);
  else if (request.action === "logout") runMcpCli(["logout", request.name]);
}

export function applyMcpPatch(existing, request, creating = false) {
  const base = structuredClone(existing || {});
  if (creating) {
    for (const key of ["command", "args", "url", "transport", "headers", "auth", "oauth"]) delete base[key];
  }
  if (request.transport !== undefined) base.transport = request.transport;
  if (request.url !== undefined) { base.url = request.url; delete base.command; delete base.args; }
  if (request.executable !== undefined) { base.command = trustedExecutablePath(request.executable); base.args = request.argv || []; delete base.url; delete base.transport; }
  if (request.argv !== undefined && request.executable === undefined) base.args = [...request.argv];
  if (request.enabled !== undefined) base.enabled = request.enabled;
  if (request.timeout !== undefined) base.timeout = request.timeout;
  if (request.metadata !== undefined) base.metadata = structuredClone(request.metadata);
  if (request.oauth !== undefined) base.oauth = { ...(base.oauth && typeof base.oauth === "object" ? base.oauth : {}), ...request.oauth };
  if (request.headers !== undefined) base.headers = { ...(base.headers && typeof base.headers === "object" ? base.headers : {}), ...request.headers };
  if (request.auth !== undefined) applyAuth(base, request.auth);
  return base;
}
function applyAuth(server, auth) {
  const prior = normalizeExistingMcpAuth(server);
  if (!prior.ok) throw Object.assign(new Error(`${prior.code}: ${prior.reason}`), { code: prior.code });
  const headers = { ...(server.headers && typeof server.headers === "object" ? server.headers : {}) };
  removeAuthMaterial(server, headers, prior.auth);
  if (auth.type === "oauth") { server.auth = "oauth"; server.oauth = { ...(server.oauth && typeof server.oauth === "object" ? server.oauth : {}), ...(auth.provider ? { provider: auth.provider } : {}), ...(auth.scopes ? { scope: auth.scopes.join(" ") } : {}) }; }
  else { delete server.auth; if (auth.type === "bearer-env") headers.Authorization = `Bearer \${${auth.env}}`; if (auth.type === "header-env") headers[auth.header] = `\${${auth.env}}`; }
  if (Object.keys(headers).length) server.headers = headers; else delete server.headers;
}
function removeAuthMaterial(server, headers, priorAuth) {
  delete server.auth;
  if (priorAuth.type === "oauth") delete server.oauth;
  for (const header of Object.keys(headers)) if (header.toLowerCase() === "authorization" || /(?:token|api[-_]?key|secret|credential)/i.test(header)) delete headers[header];
}
function existingServer(name) {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const server = config?.mcp?.servers?.[name];
  if (!server || typeof server !== "object" || Array.isArray(server)) throw new Error("MCP server does not exist");
  return server;
}
function trustedExecutablePath(executable) {
  const paths = String(process.env.PATH || "").split(":").filter(Boolean);
  const candidate = paths.map((dir) => join(dir, executable)).find((path) => existsSync(path));
  if (!candidate) throw Object.assign(new Error("ADMIN_PLANE_REQUIRED: stdio executable is not installed on the trusted local PATH"), { code: "ADMIN_PLANE_REQUIRED" });
  const resolved = realpathSync(candidate);
  const stat = statSync(resolved);
  if (!stat.isFile() || !(stat.mode & 0o111) || (stat.mode & 0o022) || ![0, process.getuid?.()].includes(stat.uid)) throw Object.assign(new Error("ADMIN_PLANE_REQUIRED: stdio executable fails trusted ownership or permission checks"), { code: "ADMIN_PLANE_REQUIRED" });
  return resolved;
}
function backupConfig(action) { if (!existsSync(CONFIG_PATH)) throw new Error("OpenClaw config missing"); const dir = join(OPENCLAW_HOME, "state", "openclaw-mcp-backups"); mkdirSync(dir, { recursive: true, mode: 0o700 }); const path = join(dir, `${action}-${Date.now()}.json`); copyFileSync(CONFIG_PATH, path); return path; }

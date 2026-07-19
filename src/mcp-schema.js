import { isRecord } from "./canonical-json.js";

const ACTIONS = new Set(["list", "status", "show", "doctor", "probe", "add", "update", "login", "logout", "remove", "enable", "disable"]);
const READ_ACTIONS = new Set(["list", "status", "show", "doctor", "probe"]);
const MUTATION_ACTIONS = new Set(["add", "update", "login", "logout", "remove", "enable", "disable"]);
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV = /^[A-Z][A-Z0-9_]*$/;
const EXECUTABLES = new Set(["node", "python3", "npx", "uvx"]);
const SENSITIVE = /token|cookie|password|secret|authorization|api[_-]?key|credential/i;

export function validateMcpRequest(raw) {
  if (!isRecord(raw)) return fail("INVALID_REQUEST", "request must be an object");
  if (hasSensitiveValue(raw)) return fail("DENY", "plaintext credentials, sensitive headers, and credential URLs are not allowed");
  const allowed = new Set(["action", "name", "transport", "url", "auth", "enabled", "argv", "probe"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length) return fail("UNKNOWN_FIELD", `unknown field: ${unknown[0]}`);

  const action = String(raw.action || "").trim();
  if (!ACTIONS.has(action)) return fail("INVALID_ACTION", "unsupported MCP action");
  if (["show", "doctor", "probe", "add", "update", "login", "logout", "remove", "enable", "disable"].includes(action) && !validName(raw.name)) {
    return fail("INVALID_NAME", "MCP name is required and must be a safe identifier");
  }

  if (action === "add" || action === "update") {
    const config = validateConfiguration(raw);
    if (!config.ok) return config;
    return { ok: true, request: { action, name: raw.name, ...config.request } };
  }
  if (["enable", "disable", "login", "logout", "remove"].includes(action) && Object.keys(raw).some((key) => !["action", "name"].includes(key))) {
    return fail("UNKNOWN_FIELD", `${action} only accepts action and name`);
  }
  if (["list", "status"].includes(action) && Object.keys(raw).some((key) => key !== "action")) {
    return fail("UNKNOWN_FIELD", `${action} only accepts action`);
  }
  if (["show", "doctor", "probe"].includes(action) && Object.keys(raw).some((key) => !["action", "name"].includes(key))) {
    return fail("UNKNOWN_FIELD", `${action} only accepts action and name`);
  }
  return { ok: true, request: { action, ...(raw.name ? { name: raw.name } : {}) } };
}

export function mcpActionRisk(request) {
  return READ_ACTIONS.has(request.action) ? "L0" : MUTATION_ACTIONS.has(request.action) ? "L2" : "L4";
}
export function isMcpRead(request) { return READ_ACTIONS.has(request.action); }
export function mcpSummary(request) {
  const auth = request.auth?.type || "none";
  const endpointKind = request.url ? "remote" : "stdio";
  return {
    action: request.action,
    name: request.name || null,
    transport: request.transport || null,
    endpointKind,
    auth,
    oauthScopes: request.auth?.scopes || [],
    requiresGatewayReload: MUTATION_ACTIONS.has(request.action),
    probe: request.probe === true
  };
}

function validateConfiguration(raw) {
  const transport = String(raw.transport || "");
  if (!["streamable-http", "stdio"].includes(transport)) return fail("ADMIN_PLANE_REQUIRED", "unverified transport requires the local admin plane");
  const auth = validateAuth(raw.auth);
  if (!auth.ok) return auth;
  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== "boolean") return fail("INVALID_REQUEST", "enabled must be boolean");
  const probe = raw.probe === undefined ? false : raw.probe;
  if (typeof probe !== "boolean") return fail("INVALID_REQUEST", "probe must be boolean");

  if (transport === "streamable-http") {
    if (raw.argv !== undefined) return fail("UNKNOWN_FIELD", "argv is only valid for stdio");
    if (typeof raw.url !== "string") return fail("INVALID_URL", "streamable-http requires url");
    let url;
    try { url = new URL(raw.url); } catch { return fail("INVALID_URL", "url must be an absolute HTTP(S) URL"); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || /(?:token|key|secret|auth|cookie|password)/i.test(url.search)) {
      return fail("DENY", "credential URL is not allowed");
    }
    if (auth.request.type === "oauth" && url.protocol !== "https:") return fail("INVALID_URL", "OAuth MCP requires HTTPS");
    return { ok: true, request: { transport, url: url.toString(), auth: auth.request, enabled, probe } };
  }

  if (raw.url !== undefined || auth.request.type !== "none") return fail("INVALID_REQUEST", "stdio does not accept URL or HTTP auth");
  if (!Array.isArray(raw.argv) || !raw.argv.length || raw.argv.some((item) => typeof item !== "string")) return fail("INVALID_ARGV", "stdio requires structured argv");
  if (!EXECUTABLES.has(raw.argv[0])) return fail("ADMIN_PLANE_REQUIRED", "stdio executable is not in the fixed trusted set");
  if (raw.argv.some((item) => item === "-e" || item === "-c" || /(?:^|\/)(?:ba)?sh$/i.test(item) || /[;&|`$()]/.test(item))) {
    return fail("DENY", "dynamic shell and inline interpreter forms are not allowed");
  }
  return { ok: true, request: { transport, argv: [...raw.argv], auth: auth.request, enabled, probe } };
}

function validateAuth(value) {
  if (value === undefined) return { ok: true, request: { type: "none" } };
  if (!isRecord(value)) return fail("INVALID_AUTH", "auth must be an object");
  const type = String(value.type || "");
  if (type === "none") return Object.keys(value).length === 1 ? { ok: true, request: { type } } : fail("UNKNOWN_FIELD", "unknown auth field");
  if (type === "oauth") {
    const unknown = Object.keys(value).filter((key) => !["type", "scopes"].includes(key));
    if (unknown.length || (value.scopes !== undefined && (!Array.isArray(value.scopes) || value.scopes.some((scope) => typeof scope !== "string" || !scope.trim())))) {
      return fail("INVALID_AUTH", "invalid OAuth scopes");
    }
    return { ok: true, request: { type, scopes: [...(value.scopes || [])] } };
  }
  if (type === "bearer-env") {
    if (Object.keys(value).length !== 2 || !ENV.test(String(value.env || ""))) return fail("INVALID_AUTH", "bearer-env requires a safe environment variable name");
    return { ok: true, request: { type, env: String(value.env) } };
  }
  return fail("DENY", "only none, oauth, and bearer-env auth are allowed");
}

function validName(value) { return typeof value === "string" && NAME.test(value); }
function hasSensitiveValue(value, key = "") {
  if (SENSITIVE.test(key)) return true;
  if (typeof value === "string") return /(?:bearer\s+|authorization\s*:|cookie\s*:)/i.test(value);
  if (Array.isArray(value)) return value.some((item) => hasSensitiveValue(item));
  if (isRecord(value)) return Object.entries(value).some(([name, item]) => hasSensitiveValue(item, name));
  return false;
}
function fail(code, reason) { return { ok: false, code, reason }; }

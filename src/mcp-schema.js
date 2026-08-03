import { isRecord } from "./canonical-json.js";

const ACTIONS = new Set(["list", "status", "show", "doctor", "probe", "add", "update", "login", "logout", "remove", "enable", "disable"]);
const READ_ACTIONS = new Set(["list", "status", "show", "doctor", "probe"]);
const MUTATION_ACTIONS = new Set(["add", "update", "login", "logout", "remove", "enable", "disable"]);
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV = /^[A-Z_][A-Z0-9_]{0,127}$/;
const HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_HEADERS = new Set(["cookie", "set-cookie", "proxy-authorization"]);
const SENSITIVE_HEADER = /^(?:authorization|.*(?:token|api[-_]?key|secret|credential).*)$/i;
const FORBIDDEN_ARG = /[;&|`$()]/;
const DYNAMIC_INTERPRETER = new Set(["-c", "-e", "--eval", "--execute"]);
const REQUEST_FIELDS = new Set(["action", "name", "transport", "url", "auth", "enabled", "argv", "executable", "headers", "timeout", "oauth", "metadata", "probe"]);

export function validateMcpRequest(raw) {
  if (!plainObject(raw)) return fail("INVALID_REQUEST", "request must be an object");
  if (hasForbiddenKeys(raw)) return fail("DENY", "prototype fields are not allowed");
  const unknown = Object.keys(raw).filter((key) => !REQUEST_FIELDS.has(key));
  if (unknown.length) return fail("UNKNOWN_FIELD", `unknown field: ${unknown[0]}`);
  const action = typeof raw.action === "string" ? raw.action.trim() : "";
  if (!ACTIONS.has(action)) return fail("INVALID_ACTION", "unsupported mcp action");
  if (requiresName(action) && !validName(raw.name)) return fail("INVALID_NAME", "MCP name is required and must be a safe identifier");
  if (action === "add" || action === "update") return validateConfiguration(raw, action);
  if (Object.keys(raw).some((key) => !(["action", "name"].includes(key)))) return fail("UNKNOWN_FIELD", `${action} only accepts action${requiresName(action) ? " and name" : ""}`);
  return { ok: true, request: { action, ...(raw.name ? { name: raw.name } : {}) } };
}

export function normalizeExistingMcpAuth(existingConfig = {}) {
  if (!plainObject(existingConfig) || hasForbiddenKeys(existingConfig)) return migrationRequired("existing MCP configuration is not a plain object");
  if (existingConfig.auth === "oauth" || plainObject(existingConfig.oauth)) return { ok: true, auth: { type: "oauth", scopes: normalizeScopes(existingConfig.oauth?.scope) }, source: "oauth" };
  if (plainObject(existingConfig.auth)) {
    const validated = validateAuth(existingConfig.auth);
    if (validated.ok) return { ok: true, auth: validated.request, source: "auth" };
    return migrationRequired("existing auth object cannot be safely normalized");
  }
  const headers = plainObject(existingConfig.headers) ? existingConfig.headers : {};
  for (const [header, value] of Object.entries(headers)) {
    const env = placeholderEnv(value);
    if (header.toLowerCase() === "authorization" && /^Bearer\s+\$\{[A-Z_][A-Z0-9_]*\}$/i.test(String(value || ""))) return { ok: true, auth: { type: "bearer-env", env: String(value).match(/\$\{([A-Z_][A-Z0-9_]*)\}/)[1] }, source: "legacy-header" };
    if (header.toLowerCase() === "authorization" && env) return migrationRequired("legacy Authorization reference has an ambiguous scheme");
    if (env && isAllowedHeader(header) && SENSITIVE_HEADER.test(header)) return { ok: true, auth: { type: "header-env", header, env }, source: "legacy-header" };
  }
  return { ok: true, auth: { type: "none" }, source: "none" };
}

export function mcpActionRisk(request) { return READ_ACTIONS.has(request.action) ? "L0" : MUTATION_ACTIONS.has(request.action) ? "L2" : "L4"; }
export function isMcpRead(request) { return READ_ACTIONS.has(request.action); }
export function mcpSummary(request) {
  const host = request.url ? new URL(request.url).host : request.transport === "stdio" ? "stdio" : null;
  return { action: request.action, name: request.name || null, transport: request.transport || null, urlHost: host, auth: request.auth?.type || "unchanged", oauthScopes: request.auth?.scopes || [], requiresGatewayReload: MUTATION_ACTIONS.has(request.action), probe: request.probe === true };
}

function validateConfiguration(raw, action) {
  const supplied = new Set(Object.keys(raw));
  const common = validateCommon(raw);
  if (!common.ok) return common;
  if (action === "add") {
    if (typeof raw.transport !== "string") return fail("INVALID_REQUEST", "add requires transport");
    const transport = raw.transport;
    if (transport === "streamable-http") {
      const http = validateHttp(raw, true); if (!http.ok) return http;
      return success(action, raw.name, { transport, ...http.request, ...common.request });
    }
    if (transport === "stdio") {
      const stdio = validateStdio(raw, true); if (!stdio.ok) return stdio;
      return success(action, raw.name, { transport, ...stdio.request, ...common.request });
    }
    return fail("INVALID_TRANSPORT", "transport must be streamable-http or stdio");
  }
  if (!supplied.has("transport") && !hasPatchField(supplied)) return fail("INVALID_REQUEST", "update requires at least one patch field");
  if (supplied.has("transport") && !["streamable-http", "stdio"].includes(raw.transport)) return fail("INVALID_TRANSPORT", "transport must be streamable-http or stdio");
  if (raw.transport === "streamable-http" || supplied.has("url")) { const http = validateHttp(raw, false); if (!http.ok) return http; common.request = { ...common.request, ...http.request }; }
  if (raw.transport === "stdio" || supplied.has("executable") || supplied.has("argv")) { const stdio = validateStdio(raw, false); if (!stdio.ok) return stdio; common.request = { ...common.request, ...stdio.request }; }
  return success(action, raw.name, { ...(supplied.has("transport") ? { transport: raw.transport } : {}), ...common.request });
}

function validateCommon(raw) {
  const request = {};
  if (raw.auth !== undefined) { const auth = validateAuth(raw.auth); if (!auth.ok) return auth; request.auth = auth.request; }
  if (raw.enabled !== undefined) { if (typeof raw.enabled !== "boolean") return fail("INVALID_REQUEST", "enabled must be boolean"); request.enabled = raw.enabled; }
  if (raw.probe !== undefined) { if (typeof raw.probe !== "boolean") return fail("INVALID_REQUEST", "probe must be boolean"); request.probe = raw.probe; }
  if (raw.timeout !== undefined) { if (!Number.isInteger(raw.timeout) || raw.timeout < 1 || raw.timeout > 300) return fail("INVALID_REQUEST", "timeout must be an integer from 1 to 300 seconds"); request.timeout = raw.timeout; }
  if (raw.headers !== undefined) { const headers = validateHeaders(raw.headers); if (!headers.ok) return headers; request.headers = headers.request; }
  if (raw.oauth !== undefined) { const oauth = validateOAuth(raw.oauth); if (!oauth.ok) return oauth; request.oauth = oauth.request; }
  if (raw.metadata !== undefined) { if (!plainObject(raw.metadata) || hasForbiddenKeys(raw.metadata) || containsSensitiveInput(raw.metadata)) return fail("DENY", "metadata contains unsafe input"); request.metadata = structuredClone(raw.metadata); }
  return { ok: true, request };
}
function validateHttp(raw, required) {
  if (raw.argv !== undefined || raw.executable !== undefined) return fail("INVALID_REQUEST", "HTTP MCP does not accept stdio fields");
  if (raw.url === undefined && !required) return { ok: true, request: {} };
  if (typeof raw.url !== "string") return fail("INVALID_URL", "streamable-http requires url");
  let url; try { url = new URL(raw.url); } catch { return fail("INVALID_URL", "url must be an absolute HTTP(S) URL"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || /(?:token|key|secret|auth|cookie|password)/i.test(url.search)) return fail("DENY", "credential URL is not allowed");
  return { ok: true, request: { url: url.toString() } };
}
function validateStdio(raw, required) {
  if (raw.url !== undefined || raw.headers !== undefined || raw.oauth !== undefined || (raw.auth !== undefined && !isExplicitNoneAuth(raw.auth))) return fail("INVALID_REQUEST", "stdio does not accept HTTP fields");
  if (raw.executable === undefined && raw.argv === undefined && !required) return { ok: true, request: {} };
  if (typeof raw.executable !== "string" || !raw.executable || raw.executable.includes("\0") || /[\\/]/.test(raw.executable)) return fail("INVALID_EXECUTABLE", "stdio requires a fixed executable name without a path");
  if (!Array.isArray(raw.argv) || raw.argv.some((item) => typeof item !== "string" || item.includes("\0") || FORBIDDEN_ARG.test(item) || DYNAMIC_INTERPRETER.has(item))) return fail("INVALID_ARGV", "stdio requires safe structured argv");
  if (["sh", "bash", "zsh", "fish", "cmd", "powershell"].includes(raw.executable.toLowerCase())) return fail("DENY", "shell executables are not allowed");
  return { ok: true, request: { executable: raw.executable, argv: [...raw.argv] } };
}
function validateAuth(value) {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return fail("INVALID_AUTH", "auth JSON string is invalid"); } }
  if (!plainObject(value) || hasForbiddenKeys(value)) return fail("INVALID_AUTH", "auth must be a plain object");
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "none") return only(value, ["type"]) ? { ok: true, request: { type } } : fail("INVALID_AUTH", "none auth accepts only type");
  if (type === "bearer" || type === "bearer-env") { if (!only(value, ["type", "env"]) || !validEnv(value.env)) return fail("DENY", "bearer auth requires only a safe environment variable reference"); return { ok: true, request: { type: "bearer-env", env: value.env } }; }
  if (type === "header-env") { if (!only(value, ["type", "header", "env"]) || !isAllowedHeader(value.header) || !validEnv(value.env)) return fail("DENY", "header-env requires a safe header and environment variable reference"); return { ok: true, request: { type, header: value.header, env: value.env } }; }
  if (type === "oauth") { const oauth = validateOAuth({ provider: value.provider, scopes: value.scopes }, true); if (!oauth.ok || !only(value, ["type", "provider", "scopes"])) return fail("INVALID_AUTH", "OAuth auth accepts provider and scopes only"); return { ok: true, request: { type, ...oauth.request } }; }
  return fail("DENY", "unsupported auth type");
}
function isExplicitNoneAuth(value) { try { if (typeof value === "string") value = JSON.parse(value); return plainObject(value) && value.type === "none"; } catch { return false; } }
function validateHeaders(value) {
  if (!plainObject(value) || hasForbiddenKeys(value)) return fail("INVALID_HEADERS", "headers must be a plain object");
  const headers = {};
  for (const [header, text] of Object.entries(value)) {
    if (!isAllowedHeader(header) || typeof text !== "string" || /[\r\n]/.test(text) || containsSensitiveInput(text)) return fail("DENY", "unsafe header input");
    headers[header] = text;
  }
  return { ok: true, request: headers };
}
function validateOAuth(value, fromAuth = false) {
  if (!plainObject(value) || hasForbiddenKeys(value)) return fail("INVALID_AUTH", "OAuth configuration must be an object");
  if (!only(value, ["provider", "scopes"])) return fail("DENY", "OAuth secrets and callback material are not accepted");
  if (value.provider !== undefined && (typeof value.provider !== "string" || !value.provider.trim() || value.provider.length > 128)) return fail("INVALID_AUTH", "invalid OAuth provider");
  if (value.scopes !== undefined && (!Array.isArray(value.scopes) || value.scopes.some((scope) => typeof scope !== "string" || !scope.trim() || scope.length > 128))) return fail("INVALID_AUTH", "invalid OAuth scopes");
  return { ok: true, request: { ...(value.provider ? { provider: value.provider } : {}), ...(value.scopes ? { scopes: [...value.scopes] } : {}) } };
}
function success(action, name, fields) { return { ok: true, request: { action, name, ...fields } }; }
function hasPatchField(fields) { return ["url", "auth", "enabled", "argv", "executable", "headers", "timeout", "oauth", "metadata", "probe"].some((field) => fields.has(field)); }
function requiresName(action) { return !["list", "status", "doctor"].includes(action); }
function validName(value) { return typeof value === "string" && NAME.test(value); }
function validEnv(value) { return typeof value === "string" && ENV.test(value); }
function isAllowedHeader(header) { return typeof header === "string" && HEADER.test(header) && !FORBIDDEN_HEADERS.has(header.toLowerCase()) && header.toLowerCase() !== "authorization"; }
function placeholderEnv(value) { const match = typeof value === "string" && value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/); return match ? match[1] : ""; }
function normalizeScopes(scope) { return typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : []; }
function migrationRequired(reason) { return { ok: false, code: "MIGRATION_REQUIRED", reason }; }
function only(value, allowed) { return Object.keys(value).every((key) => allowed.includes(key)); }
function plainObject(value) { return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function hasForbiddenKeys(value) { if (Array.isArray(value)) return value.some(hasForbiddenKeys); if (!isRecord(value)) return false; return Object.entries(value).some(([key, item]) => FORBIDDEN_KEYS.has(key) || hasForbiddenKeys(item)); }
function containsSensitiveInput(value, key = "") { if (/(?:token|cookie|password|secret|authorization|api[-_]?key|private[-_]?key|credential)/i.test(key)) return true; if (typeof value === "string") return /(?:bearer\s+|authorization\s*:|cookie\s*:)/i.test(value) || (value.length > 80 && /^[A-Za-z0-9._~+\/=:-]+$/.test(value)); if (Array.isArray(value)) return value.some((item) => containsSensitiveInput(item)); if (isRecord(value)) return Object.entries(value).some(([name, item]) => containsSensitiveInput(item, name)); return false; }
function fail(code, reason) { return { ok: false, code, reason }; }

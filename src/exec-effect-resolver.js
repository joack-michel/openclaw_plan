import { isSensitivePath, resolveSafePath } from "./path-policy.js";
import { buildScriptIdentity, commandResourceForScript } from "./script-identity.js";
import { OPENCLAW_WORKSPACE } from "./template-config.js";

const SAFE_READ_COMMANDS = new Set(["ls", "stat", "cat", "head", "tail", "grep", "find", "echo", "pwd", "wc", "sha256sum"]);
const STATUS_COMMANDS = new Set(["date", "whoami", "hostname", "ps", "df", "du", "free", "uptime"]);
const SAFE_OPENCLAW_STATUS = new Set([
  "status",
  "gateway status",
  "cron list",
  "plugins list",
  "plugins inspect"
]);
const DANGEROUS_EXECUTABLES = new Set(["rm", "mv", "cp", "chmod", "chown", "sudo", "su", "apt", "apt-get", "npm", "pnpm", "yarn", "systemctl", "service", "curl", "wget", "ssh", "scp", "rsync"]);
const REM_DISCOVERY_COMMANDS = new Set([
  `find ${OPENCLAW_WORKSPACE}/memory/topics -type f`,
  `find ${OPENCLAW_WORKSPACE}/memory/.learnings -type f`,
  `find ${OPENCLAW_WORKSPACE}/topics -type f`,
  `find ${OPENCLAW_WORKSPACE}/.learnings -type f`
]);

export function resolveExecEffect(params = {}) {
  const command = String(params.command || "").trim();
  const cwd = String(params.cwd || params.workingDirectory || process.cwd());
  if (!command) {
    return arbitrary("missing exec command");
  }
  const remDiscovery = normalizeRemDiscoveryCommand(command);
  if (remDiscovery) {
    return {
      ...safe("READ_WORKSPACE_SAFE", "fixed REM memory discovery", "readonly", "workspace:safe-read"),
      command,
      fixedCommand: remDiscovery,
      resourceKey: "workspace:safe-read"
    };
  }
  const parsed = parseShellCommand(command);
  if (!parsed.ok) {
    return arbitrary(parsed.reason);
  }
  let strongest = { capability: "QUERY_STATUS", riskLevel: "L0", operationType: "query-status", reason: "safe status query" };
  for (const segment of parsed.commands) {
    const classified = classifySimpleCommand(segment, cwd);
    if (classified.capability === "ARBITRARY_EXEC" || classified.capability === "CONFIG_MUTATION" || classified.capability === "DELETE") {
      return classified;
    }
    strongest = stronger(strongest, classified);
  }
  return {
    ...strongest,
    parsed,
    command,
    resourceKey: strongest.resourceKey || `exec-effect:${strongest.capability}`
  };
}

// REM is allowed to turn a missing optional directory into SKIPPED.  This is
// deliberately narrower than general shell parsing: only the four declared
// absolute find commands and this exact stderr/fallback suffix are accepted.
export function normalizeRemDiscoveryCommand(command) {
  const text = String(command || "").trim();
  const suffix = /\s+2>&1(?:\s+\|\|\s+echo\s+(?:SKIPPED|"SKIPPED"|'SKIPPED'))?$/;
  const fixed = text.replace(suffix, "");
  return REM_DISCOVERY_COMMANDS.has(fixed) ? fixed : "";
}

export function parseShellCommand(command) {
  if (/[`$]\(|\$\{/.test(command)) {
    return { ok: false, reason: "command substitution or parameter expansion is not allowed for safe exec" };
  }
  const parts = splitOperators(command);
  if (!parts.ok) return parts;
  const commands = [];
  for (const part of parts.parts) {
    if (part.kind === "op") continue;
    const parsed = parseSimpleCommand(part.text);
    if (!parsed.ok) return parsed;
    commands.push(parsed.command);
  }
  return { ok: true, commands, operators: parts.parts.filter((part) => part.kind === "op").map((part) => part.text) };
}

function classifySimpleCommand(command, cwd) {
  const executable = command.argv[0] || "";
  if (!executable) return arbitrary("empty command segment");
  if (DANGEROUS_EXECUTABLES.has(executable)) {
    if (executable === "rm") return dangerous("DELETE", "delete command requires confirmation");
    if (executable === "systemctl" || executable === "service" || executable === "apt" || executable === "apt-get" || executable === "npm" || executable === "pnpm" || executable === "yarn") {
      return dangerous("CONFIG_MUTATION", "system or package mutation requires confirmation");
    }
    return arbitrary(`${executable} is not safe by default`);
  }
  if (!redirectionsSafe(command.redirections)) {
    return arbitrary("unsafe redirection");
  }
  if (executable === "openclaw") {
    const sub = command.argv.slice(1, 3).join(" ");
    const first = command.argv[1] || "";
    if (SAFE_OPENCLAW_STATUS.has(sub) || SAFE_OPENCLAW_STATUS.has(first)) {
      return safe("QUERY_STATUS", "openclaw status/list query", "query-status");
    }
    return dangerous("CONFIG_MUTATION", "openclaw mutation requires confirmation");
  }
  if (SAFE_READ_COMMANDS.has(executable)) {
    const pathCheck = classifyPaths(command.argv.slice(1), executable);
    if (!pathCheck.ok) return arbitrary(pathCheck.reason);
    return safe(pathCheck.capability, pathCheck.reason, pathCheck.operationType, pathCheck.resourceKey);
  }
  if (STATUS_COMMANDS.has(executable)) {
    return safe("QUERY_STATUS", "safe local status query", "query-status");
  }
  if (isScriptRunner(executable)) {
    const identity = buildScriptIdentity({ cwd, executable, argv: command.argv.slice(1) });
    const scriptEffect = classifyScriptIdentity(identity);
    if (scriptEffect) {
      return {
        ...scriptEffect,
        scriptIdentity: identity,
        resourceKey: commandResourceForScript(identity)
      };
    }
    return arbitrary("script runner target is not recognized as a safe effect");
  }
  return arbitrary("unknown executable");
}

function classifyScriptIdentity(identity) {
  const text = `${identity.cwd} ${identity.scriptPath}`.toLowerCase();
  const meituanScript = /\/skills\/meituan-coupon\/scripts\/(auth|query|issue)\.py$/.exec(identity.scriptPath);
  if (meituanScript) {
    const script = meituanScript[1];
    const subcommand = identity.subcommand || "";
    if (script === "issue") {
      return { capability: "MEITUAN_CLAIM_COUPON", riskLevel: "L1", operationType: "meituan-claim-coupon", reason: "fixed Meituan coupon claim script" };
    }
    if (script === "query" || (script === "auth" && /^(?:status|token-verify)$/.test(subcommand))) {
      return { capability: "MEITUAN_QUERY_COUPON", riskLevel: "L0", operationType: "meituan-query-coupon", reason: "fixed read-only Meituan script" };
    }
    return null;
  }
  if (text.includes("/skills/") && /coupon|领券/.test(text)) {
    return { capability: "CLAIM_COUPON", riskLevel: "L3", operationType: "claim-coupon", reason: "fixed business script effect" };
  }
  if (text.includes("/workspace/") && /meter|electricity|state/.test(text)) {
    if (isReadOnlyQueryScript(identity.scriptPath)) {
      return { capability: "READ_METER", riskLevel: "L0", operationType: "readonly", reason: "read-only meter query script" };
    }
    return { capability: "WRITE_OWN_TASK_STATE", riskLevel: "L2", operationType: "write-own-task-state", reason: "fixed business script effect" };
  }
  if (text.includes("/workspace/") && /logs?/.test(text) && isReadOnlyQueryScript(identity.scriptPath)) {
    return { capability: "READ_LOGS", riskLevel: "L0", operationType: "readonly", reason: "read-only log query script" };
  }
  return null;
}

function isReadOnlyQueryScript(scriptPath) {
  const filename = String(scriptPath || "").split(/[\\/]/).pop() || "";
  return /(?:^|[-_])(query|read|get|list|status)(?:[-_.]|$)/i.test(filename);
}

function classifyPaths(args, executable) {
  const pathArgs = args.filter((arg) => !arg.startsWith("-") && arg !== "{}" && arg !== ";");
  if (executable === "echo" || pathArgs.length === 0) {
    return { ok: true, capability: "QUERY_STATUS", operationType: "query-status", reason: "safe stdout-only command" };
  }
  for (const pathArg of pathArgs) {
    if (/^[A-Z_]+=.*/.test(pathArg)) continue;
    const resolved = resolveSafePath(pathArg);
    if (!resolved.ok) return { ok: false, reason: `path cannot be canonicalized: ${pathArg}` };
    if (isSensitivePath(resolved.realPath)) return { ok: false, reason: "safe exec cannot read sensitive path" };
  }
  return { ok: true, capability: "READ_WORKSPACE_SAFE", operationType: "readonly", reason: "safe workspace read/query", resourceKey: "workspace:safe-read" };
}

function splitOperators(command) {
  const parts = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1] || "";
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      if (!current.trim()) return { ok: false, reason: "empty command around operator" };
      parts.push({ kind: "command", text: current.trim() });
      parts.push({ kind: "op", text: ch + next });
      current = "";
      i += 1;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&") {
      return { ok: false, reason: `unsupported shell operator ${ch}` };
    }
    current += ch;
  }
  if (quote) return { ok: false, reason: "unterminated quote" };
  if (current.trim()) parts.push({ kind: "command", text: current.trim() });
  return { ok: true, parts };
}

function parseSimpleCommand(text) {
  const tokens = tokenize(text);
  if (!tokens.ok) return tokens;
  const argv = [];
  const redirections = [];
  for (let i = 0; i < tokens.tokens.length; i += 1) {
    const token = tokens.tokens[i];
    const redir = parseRedirection(token, tokens.tokens[i + 1]);
    if (redir) {
      redirections.push(redir.value);
      if (redir.consumedNext) i += 1;
      continue;
    }
    argv.push(token);
  }
  return { ok: true, command: { argv, redirections } };
}

function tokenize(text) {
  const tokens = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = "";
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) return { ok: false, reason: "unterminated quote" };
  if (current) tokens.push(current);
  return { ok: true, tokens };
}

function parseRedirection(token, next) {
  const compact = /^(?:(\d)?)(>>?|<)(.+)$/.exec(token);
  if (compact) return { value: { fd: compact[1] || "", op: compact[2], target: compact[3] }, consumedNext: false };
  const separate = /^(?:(\d)?)(>>?|<)$/.exec(token);
  if (separate) return { value: { fd: separate[1] || "", op: separate[2], target: next || "" }, consumedNext: true };
  return null;
}

function redirectionsSafe(redirections) {
  return redirections.every((redir) => redir.op === ">" && redir.fd === "2" && redir.target === "/dev/null");
}

function isScriptRunner(executable) {
  return executable === "python3" || executable === "python" || executable === "node" || executable === "bash" || executable === "sh";
}

function safe(capability, reason, operationType, resourceKey = "") {
  return { capability, riskLevel: capability === "READ_WORKSPACE_SAFE" || capability === "QUERY_STATUS" ? "L0" : "L1", operationType, reason, resourceKey };
}

function dangerous(capability, reason) {
  return { capability, riskLevel: "L4", operationType: capability.toLowerCase().replaceAll("_", "-"), reason };
}

function arbitrary(reason) {
  return { capability: "ARBITRARY_EXEC", riskLevel: "L4", operationType: "exec", reason };
}

function stronger(left, right) {
  const rank = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
  return rank[right.riskLevel] >= rank[left.riskLevel] ? right : left;
}

import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { matchRegisteredSkillExec, registrySkillEffect } from "./skill-registry.js";
import { isSensitivePath, resolveSafePath, trustedWorkspacePath } from "./path-policy.js";
import { buildScriptIdentity, commandResourceForScript } from "./script-identity.js";
import { NUMBER_CLI } from "./template-config.js";

const READ = new Set(["ls", "find", "cat", "head", "tail", "grep", "sort", "uniq", "wc", "cut", "tr", "readlink", "stat", "pwd", "sha256sum"]);
const WRITE = new Set(["mkdir", "touch", "cp", "mv", "printf", "echo"]);
const RUNNERS = new Set(["node", "nodejs", "python", "python3", "bash", "sh"]);
const PROJECT = new Set(["npm", "pnpm", "yarn", "git"]);
const STATUS = new Set(["date", "whoami", "hostname", "ps", "pgrep", "df", "du", "free", "uptime"]);
const EXECUTABLES = new Set([...READ, ...WRITE, "rm", "curl", "wget", "true", "false", ...RUNNERS, ...PROJECT, ...STATUS, "openclaw"]);
const MODE = new Set(["STRICT", "PERSONAL_SINGLE_USER"]);

export function resolveExecEffect(params = {}, ctx = {}) {
  const command = String(params.command || "").trim();
  const cwd = String(params.cwd || params.workdir || params.workingDirectory || ctx.workspaceDir || process.cwd());
  const runtimePolicyMode = MODE.has(ctx.runtimePolicyMode) ? ctx.runtimePolicyMode : "STRICT";
  if (!command) return denied("CONFIG_ERROR", "missing exec command");
  const parsed = parseShellCommand(command, { allowOperators: runtimePolicyMode === "PERSONAL_SINGLE_USER" });
  if (!parsed.ok) return denied("DANGEROUS_EXEC_SHAPE", parsed.reason);
  if (runtimePolicyMode === "STRICT" && (parsed.commands.length !== 1 || parsed.operators.length || parsed.commands[0].redirections.length)) return denied("DANGEROUS_EXEC_SHAPE", "shell operators and redirections are not allowed in STRICT mode");
  const effects = parsed.commands.map((segment) => classifySimpleCommand(segment, cwd, params, ctx, runtimePolicyMode));
  const bad = effects.find((effect) => effect.denialCode || effect.riskLevel === "L2");
  if (bad) return { ...bad, parsed, command };
  const protectedEffect = effects.find((effect) => effect.riskLevel === "L2");
  if (protectedEffect) return { ...protectedEffect, parsed, command, trustedLocal: true };
  for (const redirect of parsed.redirections) {
    const path = checkedPath(redirect.path, cwd, true);
    if (!path.ok) return denied(path.code, path.reason);
  }
  if (parsed.commands.length === 1 && !parsed.operators.length && !parsed.redirections.length) return { ...effects[0], parsed, command };
  return { ...safe("TRUSTED_EXEC_PLAN", "safe parsed local execution plan", "trusted-exec-plan"), parsed, command, trustedLocal: true };
}

function classifySimpleCommand(segment, cwd, params = {}, ctx = {}, runtimePolicyMode = "STRICT") {
  const [rawExecutable, ...args] = segment.argv;
  const executable = rawExecutable.startsWith("/") ? basename(rawExecutable) : rawExecutable;
  if (/^(?:mkfs(?:\..+)?|fdisk|parted|wipefs)$/.test(executable)) return denied("DANGEROUS_EXEC_SHAPE", "system destructive command is denied");
  if (rawExecutable === NUMBER_CLI) return classifyNumber(args);
  if (executable === "number") return denied("CONFIG_ERROR", "number command must use its fixed absolute path");
  if (!executable || !EXECUTABLES.has(executable)) return runtimePolicyMode === "PERSONAL_SINGLE_USER" ? confirmEffect("UNKNOWN_LOCAL_EXEC", "unknown local executable requires confirmation", "unknown-exec") : denied("CONFIG_ERROR", "unknown system executable is outside trusted policy");
  if (RUNNERS.has(executable)) return classifyRunner(executable, args, cwd, rawExecutable, params, ctx);
  if (["curl", "wget"].includes(executable)) return confirmEffect("EXTERNAL_NETWORK", "external download requires confirmation", "external-network");
  if (executable === "rm") return classifyRm(args, cwd);
  if (PROJECT.has(executable)) return classifyProject(executable, args, cwd);
  if (executable === "openclaw") return ["status", "doctor"].includes(args[0]) ? safe("QUERY_STATUS", "OpenClaw status query", "readonly") : denied("ADMIN_PLANE_REQUIRED", "OpenClaw management requires openclaw-admin");
  if (STATUS.has(executable)) return safe("QUERY_STATUS", "safe local status query", "readonly");
  if (["true", "false"].includes(executable)) return safe("QUERY_STATUS", "deterministic local status command", "readonly");
  if (executable === "find") {
    if (args.some((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg))) return denied("DANGEROUS_EXEC_SHAPE", "find execution predicates are denied");
    if (args.includes("-delete")) return confirmEffect("DELETE", "find -delete requires confirmation", "delete");
  }
  if (executable === "grep") return classifyPaths(args.slice(1), cwd, false);
  if (["printf", "echo"].includes(executable)) return safe("QUERY_STATUS", "safe local output", "readonly");
  if (["head", "tail", "wc"].includes(executable)) return classifyPaths(args, cwd, false);
  return classifyPaths(args, cwd, WRITE.has(executable));
}

function classifyRunner(executable, args, cwd, rawExecutable = executable, params = {}, ctx = {}) {
  if (args.some((arg) => ["-c", "-e", "--eval", "--require", "-r", "--loader", "--import"].includes(arg) || /^--(?:eval|require|loader|import)=/.test(arg))) return denied("DANGEROUS_EXEC_SHAPE", "inline interpreter code is denied");
  if (["bash", "sh"].includes(executable) && args.some((arg) => arg.startsWith("-"))) return denied("DANGEROUS_EXEC_SHAPE", "dynamic shell options are denied");
  if (["python", "python3"].includes(executable) && args[0] === "-m" && args[1] === "pytest") return classifyProject(executable, args, cwd);
  const identity = buildScriptIdentity({ cwd, executable: rawExecutable, argv: args });
  if (!identity.scriptPath) return denied("CONFIG_ERROR", "interpreter requires a trusted script file");
  const trusted = trustedWorkspacePath(identity.scriptPath, { requireFile: true });
  if (!trusted.ok) return denied(trusted.code, trusted.reason);
  const registered = matchRegisteredSkillExec({ argv: [rawExecutable, ...args], params, ctx });
  if (registered) return registrySkillEffect(registered);
  const path = identity.scriptPath.toLowerCase();
  if (/\/skills\/meituan-coupon\/scripts\/(auth|query)\.py$/.test(path)) return { ...safe("MEITUAN_QUERY_COUPON", "fixed read-only Meituan script", "readonly"), scriptIdentity: identity, resourceKey: commandResourceForScript(identity) };
  if (/\/skills\/meituan-coupon\/scripts\/issue\.py$/.test(path)) return { ...confirmEffect("MEITUAN_CLAIM_COUPON", "external coupon claim requires confirmation", "meituan-claim-coupon"), scriptIdentity: identity, resourceKey: commandResourceForScript(identity) };
  return { ...safe("TRUSTED_WORKSPACE_SCRIPT", "trusted workspace script", "trusted-workspace-script"), scriptIdentity: identity, resourceKey: commandResourceForScript(identity), trustedLocal: true };
}

function classifyProject(executable, args, cwd) {
  if (executable === "git") {
    if (["status", "diff", "log", "show", "branch"].includes(args[0])) return safe("QUERY_STATUS", "git read-only query", "readonly");
    if (args[0] === "push") return confirmEffect("EXTERNAL_NETWORK", "git push requires confirmation", "external-network");
    if (!["add", "commit"].includes(args[0])) return confirmEffect("UNKNOWN_LOCAL_EXEC", "git operation requires confirmation", "unknown-exec");
  }
  const root = trustedWorkspacePath(cwd, { requireDirectory: true });
  if (!root.ok) return denied(root.code, root.reason);
  if (["npm", "pnpm", "yarn"].includes(executable) && !["test", "ci", "install", "run"].includes(args[0])) return confirmEffect("UNKNOWN_LOCAL_EXEC", "package operation requires confirmation", "unknown-exec");
  return { ...safe("TRUSTED_PROJECT_COMMAND", "trusted project operation", "trusted-project-command"), trustedLocal: true };
}

function classifyRm(args, cwd) {
  if (args.some((a) => a === "/" || a === "/*")) return denied("DANGEROUS_EXEC_SHAPE", "system root deletion is denied");
  const recursive = args.some((a) => a === "--recursive" || /^-[^-]*r/.test(a));
  const paths = args.filter((a) => !a.startsWith("-"));
  if (!paths.length || paths.some((p) => /[*?[]/.test(p)) || recursive) return confirmEffect("DELETE", "recursive or bulk deletion requires confirmation", "delete");
  const path = checkedPath(paths[0], cwd, false);
  if (!path.ok) return denied(path.code, path.reason);
  return { ...safe("WORKSPACE_FILE_MUTATION", "single trusted file deletion", "workspace-file-mutation"), trustedLocal: true };
}

function classifyPaths(args, cwd, write) {
  if (args.some((arg) => /^(?:--preserve(?:=|$)|--attributes-only$|--no-dereference$|--reflink(?:=|$)|-T$)/.test(arg))) return denied("DANGEROUS_EXEC_SHAPE", "unsafe copy or move option is denied");
  const valueOptions = new Set(["-type", "-name", "-iname", "-maxdepth", "-mindepth", "-mtime", "-size", "-user", "-group", "-path", "-regex", "-printf", "-e", "-f", "-p", "-n", "-c", "-d"]);
  for (let i = 0; i < args.length; i += 1) {
    if (valueOptions.has(args[i])) { i += 1; continue; }
    if (args[i].startsWith("-") || args[i] === "{}") continue;
    const path = checkedPath(args[i], cwd, write);
    if (!path.ok) return denied(path.code, path.reason);
  }
  return { ...safe(write ? "WORKSPACE_FILE_MUTATION" : "READ_WORKSPACE_SAFE", write ? "trusted local file mutation" : "safe workspace query", write ? "workspace-file-mutation" : "readonly"), trustedLocal: true };
}

function checkedPath(value, cwd, write) {
  const resolved = resolveSafePath(value, cwd);
  if (!resolved.ok) return { ok: false, code: "UNTRUSTED_PATH", reason: resolved.reason };
  if (!write) {
    try {
      if (!statSync(resolved.realPath).isFile() && !statSync(resolved.realPath).isDirectory()) return { ok: false, code: "UNTRUSTED_PATH", reason: "read target is not a regular file or directory" };
    } catch { return { ok: false, code: "UNTRUSTED_PATH", reason: "read target cannot be statted" }; }
    return { ok: true };
  }
  const trusted = trustedWorkspacePath(resolved.realPath, { allowMissing: write });
  return trusted.ok ? { ok: true } : { ok: false, code: trusted.code, reason: trusted.reason };
}

export function parseShellCommand(command, { allowOperators = false } = {}) {
  if (/[`]|\$\(|\$\{|<\(|>\(|<<|\d+(?:>|>>|<)|(?:^|\s)(?:source|eval|exec)(?:\s|$)/.test(command)) return { ok: false, reason: "dynamic shell syntax is denied" };
  if (/(?:curl|wget)\s+[^|]+\|\s*(?:bash|sh)\b/.test(command)) return { ok: false, reason: "download and execute is denied" };
  const result = tokenize(command); if (!result.ok) return result;
  const commands = []; const operators = []; const redirections = []; let argv = [];
  for (let i = 0; i < result.tokens.length; i += 1) {
    const token = result.tokens[i];
    if (["|", "&&", "||"].includes(token)) { if (!allowOperators || !argv.length) return { ok: false, reason: "shell operators are denied" }; commands.push({ argv, redirections: [] }); argv = []; operators.push(token); continue; }
    if ([">", ">>", "<"].includes(token)) { if (!allowOperators || !result.tokens[i + 1]) return { ok: false, reason: "redirection is denied" }; redirections.push({ kind: token === "<" ? "stdin" : "stdout", append: token === ">>", path: result.tokens[++i] }); continue; }
    if (token === ";" || token === "&") return { ok: false, reason: "unsupported shell control operator" };
    argv.push(token);
  }
  if (!argv.length) return { ok: false, reason: "missing command" }; commands.push({ argv, redirections: [] });
  if (operators.length && commands.length !== operators.length + 1) return { ok: false, reason: "invalid command chain" };
  return { ok: true, commands, operators, redirections };
}

function tokenize(text) { const tokens=[]; let cur="", quote=""; for(let i=0;i<text.length;i+=1){const ch=text[i]; if(quote){if(ch===quote)quote="";else cur+=ch;continue;} if(ch==='"'||ch==="'"){quote=ch;continue;} if(/\s/.test(ch)){if(cur){tokens.push(cur);cur="";}continue;} if("|;&<>".includes(ch)){if(cur){tokens.push(cur);cur="";}let op=ch;if((ch==='|'||ch==='&'||ch==='>')&&text[i+1]===ch){op+=ch;i+=1;}tokens.push(op);continue;}cur+=ch;}if(quote)return {ok:false,reason:"unterminated quote"};if(cur)tokens.push(cur);return {ok:true,tokens}; }
function classifyNumber(argv) { const exact=(...want)=>argv.length===want.length&&want.every((v,i)=>argv[i]===v); if (exact("query","telecom-main") || exact("report","--period","current","--format","qq") || exact("report","--period","yesterday","--format","qq") || exact("auth","status","telecom-main")) return safe("NUMBER_QUERY", "fixed number query", "readonly"); if (exact("auth","start","telecom-main") || exact("auth","submit","telecom-main","--stdin")) return safe("NUMBER_AUTH", "fixed number auth", "number-auth"); return denied("CONFIG_ERROR", "number command is outside fixed scope"); }
function safe(capability, reason, operationType, resourceKey = "") { return { capability, riskLevel: ["READ_WORKSPACE_SAFE", "QUERY_STATUS", "MEITUAN_QUERY_COUPON", "NUMBER_QUERY"].includes(capability) ? "L0" : "L1", operationType, reason, resourceKey }; }
function confirmEffect(capability, reason, operationType) { return { capability, riskLevel: "L2", operationType, reason }; }
function denied(denialCode, reason) { return { capability: denialCode === "ADMIN_PLANE_REQUIRED" ? "CONFIG_MUTATION" : "ARBITRARY_EXEC", riskLevel: "L4", operationType: "exec", reason, denialCode }; }
export function normalizeRemDiscoveryCommand() { return ""; }

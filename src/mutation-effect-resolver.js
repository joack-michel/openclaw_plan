import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { isSensitivePath, resolveSafePath } from "./path-policy.js";
import { REM_CRON_JOB_ID, OPENCLAW_WORKSPACE, OPENCLAW_HOME, EXECUTION_GATE_HOME } from "./template-config.js";


const FILE_TOOLS = new Set(["write", "edit", "apply_patch"]);

export function resolveMutationEffect(event = {}) {
  const toolName = String(event.toolName || "").trim();
  if (!FILE_TOOLS.has(toolName)) return null;
  const params = event.params && typeof event.params === "object" ? event.params : {};
  const ctx = event.ctx && typeof event.ctx === "object" ? event.ctx : {};
  const path = String(params.path || params.file_path || params.filePath || "").trim();
  if (!path) return effect("UNKNOWN_MUTATION", "unknown-mutation", "mutation target path is missing", "mutation:unknown");
  const target = canonicalTarget(path, ctx.workspaceDir);
  if (isSecurityComponentPath(target)) return effect("SECURITY_COMPONENT_MUTATION", "security-component-mutation", "Execution Gate component mutation requires local admin", `file:${target}`);
  if (isSecurityPolicyPath(target)) return effect("SECURITY_POLICY_MUTATION", "security-policy-mutation", "security policy mutation requires local admin", `file:${target}`);
  if (isRegistryPath(target)) return effect("REGISTRY_MUTATION", "registry-mutation", "Skill Registry mutation requires local admin", `file:${target}`);
  if (isApprovalsPath(target)) return effect("APPROVALS_MUTATION", "approvals-mutation", "Host approvals mutation requires local admin", `file:${target}`);
  if (isConfigPath(target)) return effect("CONFIG_MUTATION", "config-mutation", "configuration or credential mutation requires local admin", `file:${target}`);
  if (isRemOwnMemoryMutation(ctx, target)) return effect("WRITE_OWN_MEMORY_STATE", "write-own-memory-state", "REM-owned memory state mutation requires its active automation grant", "memory-state:own");
  if (isExplicitOwnTaskState(params, target)) return effect("WRITE_OWN_TASK_STATE", "write-own-task-state", "task-owned state mutation", `file:${target}`);
  if (isOrdinaryWorkspacePath(target)) return effect("WORKSPACE_FILE_MUTATION", "workspace-file-mutation", "ordinary workspace file mutation", `file:${target}`);
  return effect("UNKNOWN_MUTATION", "unknown-mutation", "mutation target is outside ordinary workspace roots", `file:${target}`);
}

function effect(kind, operationType, reason, resourceKey) {
  const direct = kind === "WORKSPACE_FILE_MUTATION";
  return { kind, riskLevel: direct ? "L1" : kind === "WRITE_OWN_TASK_STATE" || kind === "WRITE_OWN_MEMORY_STATE" ? "L2" : "L4", operationType, reason, resourceKey };
}

function isSecurityPolicyPath(path) {
  const policyRoot = resolve(OPENCLAW_WORKSPACE, "policy");
  return under(path, policyRoot) && /(?:^|\/)(?:security-constitution\.md|execution-policy\.md|tool-risk-map\.json|integrity(?:\/|$))/i.test(path.slice(policyRoot.length));
}

function isConfigPath(path) {
  const openclawRoot = OPENCLAW_HOME;
  return path === resolve(openclawRoot, "openclaw.json") || /(?:^|\/)(?:\.env[^/]*|credentials?|secrets?|auth-profiles?)(?:$|\/|\.)/i.test(path);
}

function isRegistryPath(path) { return /(?:execution-manifest\.json$|\.openclaw\/state\/skill-registry\.json$)/i.test(path); }
function isApprovalsPath(path) { return /\.openclaw\/state\/exec-approvals\.json$/i.test(path); }

function isSecurityComponentPath(path) {
  return under(path, EXECUTION_GATE_HOME);
}

function isOrdinaryWorkspacePath(path) {
  return [
    OPENCLAW_WORKSPACE,
    resolve(OPENCLAW_HOME, "skills"),
    resolve(OPENCLAW_HOME, "agents")
  ].some((root) => under(path, root));
}

function isExplicitOwnTaskState(params, path) {
  return params.taskState === true && typeof params.ownerId === "string" && params.ownerId.trim() !== "" && isOrdinaryWorkspacePath(path);
}

function isRemOwnMemoryMutation(ctx, path) {
  const sessionKey = String(ctx.sessionKey || "");
  if (ctx.agentId !== "main" || (!sessionKey.includes(`:cron:${REM_CRON_JOB_ID}:run:`) && ctx.executionGateManualRem !== true)) return false;
  const workspace = resolve(String(ctx.workspaceDir || OPENCLAW_WORKSPACE));
  if (workspace !== OPENCLAW_WORKSPACE) return false;
  const canonical = resolveSafePath(path, workspace);
  if (!canonical.ok || isSensitivePath(canonical.realPath)) return false;
  const roots = [
    resolve(workspace, "memory"),
    resolve(workspace, "topics"),
    resolve(workspace, ".learnings")
  ];
  return canonical.realPath === resolve(workspace, "MEMORY.md") || roots.some((root) => under(canonical.realPath, root));
}

function canonicalTarget(path, workspaceDir = "") {
  return resolve(String(workspaceDir || ""), path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
}

function under(path, root) {
  return path === root || path.startsWith(`${root}${sep}`);
}

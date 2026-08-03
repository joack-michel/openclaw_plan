import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isRecord } from "./canonical-json.js";
import { validateMcpRequest } from "./mcp-schema.js";
import { executeMcpMutations } from "./mcp-management.js";
import { workspacePath } from "./template-config.js";

const SKILLS_ROOT = workspacePath("skills");
const ID = /^[a-z][a-z0-9-]{2,62}$/;
const DANGEROUS = new Set(["shell", "command", "cwd", "env", "headers", "gateway", "rpc"]);

export function validateSkillManageRequest(raw) {
  if (!isRecord(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return fail("INVALID_REQUEST", "skill request must be an object");
  if (raw.action === "uninstall") return typeof raw.id === "string" && ID.test(raw.id) ? { ok: true, request: { action: "uninstall", id: raw.id } } : fail("INVALID_SKILL", "skill id must be a safe identifier");
  if (raw.action !== "install") return fail("INVALID_ACTION", "action must be install or uninstall");
  const manifest = raw.manifest;
  if (!isRecord(manifest) || Object.getPrototypeOf(manifest) !== Object.prototype) return fail("INVALID_MANIFEST", "manifest must be an object");
  if (Object.keys(manifest).some((key) => DANGEROUS.has(key) || ["__proto__", "prototype", "constructor"].includes(key))) return fail("DENY", "manifest contains an unsafe field");
  const id = typeof manifest.id === "string" ? manifest.id : "";
  if (!ID.test(id)) return fail("INVALID_SKILL", "manifest id must be a safe identifier");
  if (manifest.name !== undefined && (typeof manifest.name !== "string" || manifest.name.length > 120)) return fail("INVALID_MANIFEST", "invalid skill name");
  if (manifest.description !== undefined && (typeof manifest.description !== "string" || manifest.description.length > 500)) return fail("INVALID_MANIFEST", "invalid skill description");
  if (manifest.mcpServers !== undefined && !Array.isArray(manifest.mcpServers)) return fail("INVALID_MANIFEST", "mcpServers must be an array");
  const mcps = [];
  for (const server of manifest.mcpServers || []) {
    if (!isRecord(server)) return fail("INVALID_MANIFEST", "MCP entry must be an object");
    const result = validateMcpRequest({ ...server, action: "add" });
    if (!result.ok) return fail(result.code, `MCP ${result.reason}`);
    mcps.push(result.request);
  }
  const names = new Set(mcps.map((item) => item.name));
  if (names.size !== mcps.length) return fail("INVALID_MANIFEST", "MCP names must be unique within a Skill");
  return { ok: true, request: { action: "install", manifest: { id, ...(manifest.name ? { name: manifest.name } : {}), ...(manifest.description ? { description: manifest.description } : {}), ...(mcps.length ? { mcpServers: mcps } : {}) } } };
}

export function executeSkillManagePlan(request, options = {}) {
  const root = options.skillsRoot || SKILLS_ROOT;
  if (request.action === "uninstall") return uninstall(request.id, root);
  return install(request.manifest, root, options);
}

function install(manifest, root, options) {
  mkdirSync(root, { recursive: true, mode: 0o750 });
  const destination = join(root, manifest.id);
  if (existsSync(destination)) throw new Error("skill already exists; use a separately confirmed upgrade flow");
  const stage = mkdtempSync(join(tmpdir(), "openclaw-skill-plan-"));
  const stagedSkill = join(stage, manifest.id);
  const backup = join(stage, "previous-skill");
  try {
    mkdirSync(stagedSkill, { recursive: true, mode: 0o750 });
    writeFileSync(join(stagedSkill, "SKILL.md"), renderSkill(manifest), { mode: 0o640 });
    // Validate all MCP entries before changing either durable resource.
    const checked = validateSkillManageRequest({ action: "install", manifest });
    if (!checked.ok) throw new Error(`${checked.code}: ${checked.reason}`);
    const mcp = executeMcpMutations(checked.request.manifest.mcpServers || []);
    renameSync(stagedSkill, destination);
    return { skillId: manifest.id, mcpCount: checked.request.manifest.mcpServers?.length || 0, mcp };
  } catch (error) {
    if (existsSync(destination)) { copyFileSync(join(destination, "SKILL.md"), join(backup, "SKILL.md")); rmSync(destination, { recursive: true, force: true }); }
    if (existsSync(backup)) renameSync(backup, destination);
    throw error;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

function uninstall(id, root) {
  const destination = join(root, id);
  if (!existsSync(destination)) throw new Error("skill does not exist");
  const stage = mkdtempSync(join(tmpdir(), "openclaw-skill-remove-"));
  try { renameSync(destination, join(stage, id)); return { skillId: id, removed: true }; }
  catch (error) { throw error; }
  finally { rmSync(stage, { recursive: true, force: true }); }
}

function renderSkill(manifest) {
  return `# ${manifest.name || manifest.id}\n\n${manifest.description || "Declarative Skill managed by Execution Gate."}\n`;
}
function fail(code, reason) { return { ok: false, code, reason }; }

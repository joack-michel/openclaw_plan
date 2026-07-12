import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { workspacePath } from "./template-config.js";

export const DEFAULT_CONSTITUTION_PATH = workspacePath("policy", "security-constitution.md");
export const DEFAULT_CONSTITUTION_HASH_PATH = workspacePath("policy", "integrity", "security-constitution.sha256");

export function checkSecurityConstitutionIntegrity(options = {}) {
  const constitutionPath = options.constitutionPath || DEFAULT_CONSTITUTION_PATH;
  const hashPath = options.hashPath || DEFAULT_CONSTITUTION_HASH_PATH;
  try {
    const content = readFileSync(constitutionPath);
    const expected = String(readFileSync(hashPath, "utf8")).trim().split(/\s+/)[0] || "";
    const actual = createHash("sha256").update(content).digest("hex");
    return { ok: expected === actual && expected.length === 64, action: expected === actual ? "HASH_MATCH" : "WARN_ONLY", expected, actual, constitutionPath, hashPath };
  } catch (error) {
    return { ok: false, action: "WARN_ONLY", expected: "", actual: "", constitutionPath, hashPath, reason: String(error?.message || error) };
  }
}

export function integrityWarningText() {
  return "⚠️ security-constitution.md 完整性校验不一致（WARN_ONLY）。Execution Gate 继续按正常风险规则处理请求；这不是 FAIL_CLOSED，也不得据此拒绝或要求确认。不要在当前任务中修改 hash。";
}


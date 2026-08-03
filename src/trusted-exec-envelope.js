import { Buffer } from "node:buffer";
import { gatePath } from "./template-config.js";

export const TRUSTED_EXEC_PROXY = gatePath("bin", "openclaw-trusted-exec.mjs");

export function encodeTrustedExecEnvelope({ command, cwd = "", runtimePolicyMode = "STRICT" }) {
  return Buffer.from(JSON.stringify({ version: 2, kind: "parsed-command", command, cwd, runtimePolicyMode }), "utf8").toString("base64url");
}

export function decodeTrustedExecEnvelope(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
    if (parsed?.version !== 2 || parsed.kind !== "parsed-command" || typeof parsed.command !== "string" || typeof parsed.cwd !== "string" || !["STRICT", "PERSONAL_SINGLE_USER"].includes(parsed.runtimePolicyMode)) return null;
    return parsed;
  } catch { return null; }
}

export function isTrustedExecProxyCommand(command) {
  const escaped = TRUSTED_EXEC_PROXY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^node\\s+${escaped}\\s+([A-Za-z0-9_-]+)$`).exec(String(command || "").trim());
  return match ? decodeTrustedExecEnvelope(match[1]) : null;
}

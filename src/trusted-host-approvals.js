import { NODE_EXECUTABLE, gatePath } from "./template-config.js";

function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
const trustedExec = escapeRegex(gatePath("bin", "openclaw-trusted-exec.mjs"));
const mcpAgent = escapeRegex(gatePath("bin", "openclaw-mcp-agent.mjs"));

export const trustedDiscoveryApprovals = [
  { pattern: NODE_EXECUTABLE, argPattern: `^${trustedExec} [A-Za-z0-9_-]+$` },
  { pattern: NODE_EXECUTABLE, argPattern: `^${mcpAgent} (?:--read [A-Za-z0-9_-]+|op_[A-Za-z0-9-]+)$` }
];

export function mergeTrustedDiscoveryApprovals(config, agent = "main") {
  const next = structuredClone(config);
  const current = next.agents?.[agent];
  if (!current || current.security !== "allowlist" || current.ask !== "off" || current.askFallback !== "deny") throw new Error("host approval mode is not strict allowlist/off/deny");
  current.allowlist ??= [];
  const legacy = new Set(["/usr/bin/ls", "/usr/bin/find", "/usr/bin/cat", "/usr/bin/stat", "/usr/bin/pwd"]);
  current.allowlist = current.allowlist.filter((item) => !legacy.has(item.pattern));
  for (const entry of trustedDiscoveryApprovals) if (!current.allowlist.some((item) => item.pattern === entry.pattern && item.argPattern === entry.argPattern)) current.allowlist.push(entry);
  return next;
}

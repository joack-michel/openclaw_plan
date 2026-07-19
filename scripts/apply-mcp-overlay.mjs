#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changed = [];

patch("src/index.js", (text) => {
  if (text.includes('from "./mcp-schema.js"')) return text;
  text = insertAfter(text,
    'import { adminPlaneRequired } from "./runtime-plane.js";',
    '\nimport { spawnSync } from "node:child_process";\nimport { validateMcpRequest } from "./mcp-schema.js";');
  const registration = `
    api.registerTool?.({
      name: "mcp_manage",
      label: "Manage MCP",
      description: "Manage ordinary MCP servers. Read actions are direct; configuration changes require confirmation. Plaintext credentials and arbitrary commands are rejected.",
      parameters: {
        type: "object",
        additionalProperties: true,
        properties: {
          action: { type: "string" }, name: { type: "string" }, transport: { type: "string" },
          url: { type: "string" }, auth: {}, enabled: { type: "boolean" },
          argv: { type: "array", items: { type: "string" } }, probe: { type: "boolean" }
        },
        required: ["action"]
      },
      async execute(toolCallId, params) {
        const validated = validateMcpRequest(params);
        if (!validated.ok) return { content: [{ type: "text", text: \`${'${validated.code}'}: ${'${validated.reason}'}\` }] };
        const read = ["list", "status", "show", "doctor", "probe"].includes(validated.request.action);
        const operationId = read ? "" : store.getExecutingOperationByToolCall("mcp_manage", toolCallId)?.operation_id || "";
        const args = read
          ? ["--read", Buffer.from(JSON.stringify(validated.request)).toString("base64url")]
          : [operationId];
        if (!read && !/^op_[0-9a-f-]+$/i.test(operationId)) throw new Error("confirmed MCP operation was not found");
        const result = spawnSync(process.execPath, [new URL("../bin/openclaw-mcp-agent.mjs", import.meta.url).pathname, ...args], {
          encoding: "utf8", shell: false, env: { ...process.env, EXECUTION_GATE_DB_PATH: store.dbPath }
        });
        if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "MCP wrapper failed"));
        return { content: [{ type: "text", text: String(result.stdout || "{}").trim() }] };
      }
    });`;
  return insertAfter(text,
    '    store.markStaleExecutingUnknown({ olderThanMs: cfg.executionTimeoutMs });',
    registration);
});

patch("src/operation-store.js", (text) => {
  if (text.includes("getExecutingOperationByToolCall(toolName, toolCallId)")) return text;
  const methods = `
  getCanonicalRequest(operationId, expectedToolName = "") {
    this.open();
    const row = this.db.prepare(\`SELECT o.*, p.canonical_params_json FROM operations o JOIN operation_params p ON p.operation_id = o.operation_id WHERE o.operation_id = ?\`).get(operationId);
    if (!row || (expectedToolName && row.tool_name !== expectedToolName)) return null;
    return row;
  }

  getExecutingOperationByToolCall(toolName, toolCallId) {
    this.open();
    if (!toolCallId) return null;
    return this.db.prepare(\`SELECT o.operation_id FROM operations o JOIN execution_attempts a ON a.operation_id = o.operation_id WHERE o.tool_name = ? AND a.tool_call_id = ? AND o.status = 'EXECUTING' ORDER BY a.started_at DESC LIMIT 1\`).get(toolName, toolCallId) || null;
  }

`;
  return insertBefore(text, "  findPendingByContext(", methods);
});

patch("src/risk-resolver.js", (text) => {
  if (text.includes('from "./mcp-schema.js"')) return text;
  text = insertAfter(text,
    'import { evaluatePathPolicy } from "./path-policy.js";',
    '\nimport { isMcpRead, mcpActionRisk, validateMcpRequest } from "./mcp-schema.js";');
  const block = `

  if (toolName === "mcp_manage") {
    const validated = validateMcpRequest(params);
    if (!validated.ok) return protectedDecision("DENY", "L4", "mcp-management", \`${'${validated.code}'}: ${'${validated.reason}'}\`, toolName, source, params);
    if (config.runtimePolicyMode !== "PERSONAL_SINGLE_USER") {
      return { ...protectedDecision("PROTECTED", "L4", "gateway-config", "MCP management requires the local admin plane outside personal mode", toolName, source, params), capability: { kind: "CONFIG_MUTATION", riskLevel: "L4" } };
    }
    const capability = {
      kind: isMcpRead(validated.request) ? "MCP_QUERY" : "MCP_MANAGEMENT",
      riskLevel: mcpActionRisk(validated.request), operationType: "mcp-management",
      resourceKey: \`mcp:${'${validated.request.name || "all"}'}\`, mcpRequest: validated.request
    };
    if (isMcpRead(validated.request)) return { action: "ALLOW", path: "L0_MCP_MANAGEMENT", riskLevel: "L0", operationType: "readonly", reason: "MCP read operation", toolName, rawName, source, capability };
    return { ...protectedDecision("PROTECTED", "L2", "mcp-management", "MCP configuration requires confirmation", toolName, source, params), capability };
  }`;
  text = insertAfter(text, "  const params = canonicalParams(event?.params);", block);
  return insertAfter(text, "function isDirectSafeCapability(kind) {", '\n  if (kind === "MCP_QUERY") return true;');
});

patch("bin/openclaw-admin.mjs", (text) => {
  if (text.includes('from "../src/mcp-management.js"')) return text;
  text = insertAfter(text,
    'import { cronActionArgs, cronCreateArgs, cronJobId, cronUpdateArgs } from "../src/admin/cron-admin.js";',
    '\nimport { executeMcpRequest } from "../src/mcp-management.js";\nimport { validateMcpRequest } from "../src/mcp-schema.js";');
  text = insertAfter(text, '  if (group === "cron") return cron(sub, args);', '\n  if (group === "mcp") return mcp(sub, args);');
  text = text.replace("{status|doctor|openclaw|cron|", "{status|doctor|openclaw|mcp|cron|");
  const fn = 'function mcp(action, values) { const raw = action === "request" ? JSON.parse(values[0] || "") : { action, name: values[0] }; const validated = validateMcpRequest(raw); if (!validated.ok) throw new Error(`${validated.code}: ${validated.reason}`); console.log(JSON.stringify(executeMcpRequest(validated.request), null, 2)); }\n';
  return insertBefore(text, "function openclaw(command, values)", fn);
});

patch("test/mock-hook.test.js", (text) => {
  if (text.includes("registerTool: () => {}")) return text;
  return insertAfter(text, "      logger: console,", "\n      registerTool: () => {},");
}, { optional: true });

console.log(JSON.stringify({ ok: true, changed }, null, 2));

function patch(relative, transform, { optional = false } = {}) {
  const path = resolve(root, relative);
  if (!existsSync(path)) {
    if (optional) return;
    throw new Error(`required restored file missing: ${relative}`);
  }
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (after !== before) {
    writeFileSync(path, after);
    changed.push(relative);
  }
}
function insertAfter(text, needle, addition) {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`overlay anchor missing: ${needle}`);
  return text.slice(0, index + needle.length) + addition + text.slice(index + needle.length);
}
function insertBefore(text, needle, addition) {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`overlay anchor missing: ${needle}`);
  return text.slice(0, index) + addition + text.slice(index);
}

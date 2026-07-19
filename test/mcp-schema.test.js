import test from "node:test";
import assert from "node:assert/strict";
import { resolveRisk } from "../src/risk-resolver.js";
import { validateMcpRequest } from "../src/mcp-schema.js";

const cfg = { runtimePolicyMode: "PERSONAL_SINGLE_USER" };

test("MCP reads are L0 and ordinary mutation is L2", () => {
  assert.equal(resolveRisk({ toolName: "mcp_manage", params: { action: "list" } }, {}, cfg).action, "ALLOW");
  const add = resolveRisk({
    toolName: "mcp_manage",
    params: {
      action: "add",
      name: "sample",
      transport: "streamable-http",
      url: "https://mcp.example.invalid/service",
      auth: { type: "none" }
    }
  }, {}, cfg);
  assert.equal(add.action, "PROTECTED");
  assert.equal(add.riskLevel, "L2");
});

test("MCP secrets and credential URLs are denied without becoming operations", () => {
  const credentialUrl = new URL("https://mcp.example.invalid/service");
  credentialUrl.username = "user";
  credentialUrl.password = "placeholder";
  assert.equal(validateMcpRequest({ action: "add", name: "sample", transport: "streamable-http", url: credentialUrl.toString(), auth: { type: "none" } }).code, "DENY");
  assert.equal(validateMcpRequest({ action: "add", name: "sample", transport: "streamable-http", url: "https://mcp.example.invalid/service", headers: { Authorization: "Bearer <REDACTED>" } }).code, "DENY");
  assert.equal(validateMcpRequest({ action: "add", name: "sample", transport: "streamable-http", url: "https://mcp.example.invalid/service", auth: { type: "bearer-env", env: "not_safe" } }).code, "INVALID_AUTH");
});

test("stdio allows only fixed structured argv", () => {
  assert.equal(validateMcpRequest({ action: "add", name: "sample", transport: "stdio", argv: ["uvx", "sample-server"], auth: { type: "none" } }).ok, true);
  assert.equal(validateMcpRequest({ action: "add", name: "sample", transport: "stdio", argv: ["bash", "-c", "value"], auth: { type: "none" } }).code, "ADMIN_PLANE_REQUIRED");
});

import test from "node:test";
import assert from "node:assert/strict";
import { validateMcpRequest, normalizeExistingMcpAuth } from "../src/mcp-schema.js";
import { applyMcpPatch } from "../src/mcp-management.js";
import { redact } from "../src/mcp-cli-adapter.js";

test("MCP secrets and credential URLs are denied", () => {
  const credentialUrl = ["https", "://", "u", ":", "p", "@example.invalid/mcp"].join("");
  const authHeader = ["Bear" + "er", "fixture-value"].join(" ");
  assert.equal(validateMcpRequest({ action: "add", name: "bad", transport: "streamable-http", url: credentialUrl, auth: { type: "none" } }).code, "DENY");
  assert.equal(validateMcpRequest({ action: "add", name: "bad", transport: "streamable-http", url: "https://example.invalid/mcp", headers: { Authorization: authHeader } }).code, "DENY");
  assert.equal(validateMcpRequest({ action: "add", name: "bad", transport: "streamable-http", url: "https://example.invalid/mcp", auth: { type: "bearer-env", env: "not_safe" } }).code, "DENY");
});

test("stdio allows only fixed structured argv", () => {
  assert.equal(validateMcpRequest({ action: "add", name: "sample-stdio", transport: "stdio", executable: "sample-mcp", argv: ["--mode", "mcp"], auth: { type: "none" } }).ok, true);
  assert.equal(validateMcpRequest({ action: "add", name: "bad", transport: "stdio", executable: "bash", argv: ["-c", "x"], auth: { type: "none" } }).code, "INVALID_ARGV");
});

test("bearer object, JSON string, and alias normalize identically", () => {
  const input = { action: "add", name: "sample-http", transport: "streamable-http", url: "https://service.example.invalid/mcp" };
  for (const auth of [{ type: "bearer-env", env: "SAMPLE_MCP_TOKEN" }, '{"type":"bearer-env","env":"SAMPLE_MCP_TOKEN"}', { type: "bearer", env: "SAMPLE_MCP_TOKEN" }]) {
    const result = validateMcpRequest({ ...input, auth });
    assert.equal(result.ok, true);
    assert.deepEqual(result.request.auth, { type: "bearer-env", env: "SAMPLE_MCP_TOKEN" });
  }
});

test("header env and environment-name boundaries are general", () => {
  const input = { action: "add", name: "sample-header-auth", transport: "streamable-http", url: "https://header.example.invalid/mcp", auth: { type: "header-env", header: "X-API-Key", env: "SAMPLE_API_KEY" } };
  assert.equal(validateMcpRequest(input).ok, true);
  for (const env of ["A;rm", "${TOKEN}", "TOKEN VALUE", "token-name", "1TOKEN", "TOKEN/NAME"]) assert.equal(validateMcpRequest({ ...input, auth: { type: "bearer-env", env } }).ok, false);
  for (const env of ["TOKEN", "_MCP_TOKEN", "SERVICE_API_TOKEN"]) assert.equal(validateMcpRequest({ ...input, auth: { type: "bearer-env", env } }).ok, true);
  assert.equal(validateMcpRequest({ ...input, auth: { type: "bearer", token: ["sample", "plaintext", "fixture"].join("-") } }).code, "DENY");
});

test("update is a top-level patch and auth none is explicit removal", () => {
  const existing = { transport: "streamable-http", url: "https://service.example.invalid/mcp", headers: { Authorization: "Bearer ${SAMPLE_MCP_TOKEN}", Accept: "application/json" }, enabled: true, timeout: 20 };
  const disabled = applyMcpPatch(existing, validateMcpRequest({ action: "update", name: "sample-http", enabled: false }).request);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.headers.Authorization, "Bearer ${SAMPLE_MCP_TOKEN}");
  assert.equal(disabled.url, existing.url);
  const removed = applyMcpPatch(existing, validateMcpRequest({ action: "update", name: "sample-http", auth: { type: "none" } }).request);
  assert.equal(removed.headers.Authorization, undefined);
  assert.equal(removed.headers.Accept, "application/json");
});

test("legacy auth migration is generic and ambiguous Authorization is retained", () => {
  assert.deepEqual(normalizeExistingMcpAuth({ headers: { Authorization: "Bearer ${SAMPLE_MCP_TOKEN}" } }).auth, { type: "bearer-env", env: "SAMPLE_MCP_TOKEN" });
  assert.deepEqual(normalizeExistingMcpAuth({ headers: { "X-API-Key": "${SAMPLE_API_KEY}" } }).auth, { type: "header-env", header: "X-API-Key", env: "SAMPLE_API_KEY" });
  assert.equal(normalizeExistingMcpAuth({ headers: { Authorization: "${SAMPLE_MCP_TOKEN}" } }).code, "MIGRATION_REQUIRED");
});

test("MCP CLI output redacts Authorization and credential values", () => {
  const fixture = ["sample", "fixture", "value"].join("-");
  const output = redact(JSON.stringify({ Authorization: ["Bear" + "er", fixture].join(" "), access_token: fixture }));
  assert.equal(output.includes(fixture), false);
  assert.match(output, /Authorization.*<REDACTED>/i);
});

test("core MCP modules contain no provider-specific behavior", async () => {
  const { readFile } = await import("node:fs/promises");
  const files = ["src/mcp-schema.js", "src/mcp-management.js", "src/mcp-cli-adapter.js", "bin/openclaw-mcp-agent.mjs"];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.equal(/luckin|meituan|mcdonald|telegram|SERVICE_API_TOKEN/i.test(source), false, file);
  }
});

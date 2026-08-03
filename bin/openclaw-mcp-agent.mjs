#!/usr/bin/env node
import { OperationStore } from "../src/operation-store.js";
import { sha256Hex } from "../src/canonical-json.js";
import { executeMcpRequest } from "../src/mcp-management.js";
import { validateMcpRequest } from "../src/mcp-schema.js";

const [operationId = "", encodedRead = ""] = process.argv.slice(2);
try {
  let request;
  if (operationId === "--read") {
    request = JSON.parse(Buffer.from(encodedRead, "base64url").toString("utf8"));
  } else {
    if (!/^op_[0-9a-f-]+$/i.test(operationId)) throw new Error("invalid operation id");
    const store = new OperationStore(process.env.EXECUTION_GATE_DB_PATH || "");
    const operation = store.getCanonicalRequest(operationId, "mcp_manage");
    if (!operation || operation.status !== "EXECUTING") throw new Error("operation is not executing");
    if (sha256Hex(operation.canonical_params_json) !== operation.frozen_params_hash) throw new Error("canonical request hash mismatch");
    request = JSON.parse(operation.canonical_params_json);
  }
  const validated = validateMcpRequest(request);
  if (!validated.ok) throw new Error(`${validated.code}: ${validated.reason}`);
  const result = executeMcpRequest(validated.request);
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
}

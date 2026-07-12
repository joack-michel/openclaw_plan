import { createHash, randomUUID } from "node:crypto";

export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalParams(params) {
  const clone = { ...(isRecord(params) ? params : {}) };
  delete clone.operation_id;
  delete clone.operationId;
  delete clone.execution_gate_operation_id;
  return clone;
}

export function canonicalParamsJson(params) {
  return stableStringify(canonicalParams(params));
}

export function paramsHash(params) {
  return sha256Hex(canonicalParamsJson(params));
}

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}



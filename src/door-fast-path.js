import { isRecord, sha256Hex, stableStringify } from "./canonical-json.js";
import { EXAMPLE_ACCESS_CONTROL_SCOPE } from "./risk-resolver.js";

const DEDUPE_MS = 10_000;
const inflightScopes = new Set();
const recentScopes = new Map();

export function isExampleAccessControlDoorFastPath(decision, config = {}) {
  if (config.allowExampleAccessControlDoorFastPath === false) {
    return false;
  }
  return decision?.action === "ALLOW" && decision?.path === "L1_FAST_PATH" && decision?.operationType === "door-open" && decision?.conflictScope === EXAMPLE_ACCESS_CONTROL_SCOPE && (decision?.toolName === "door-open" || decision?.toolName === "exec");
}

export function doorScopeFromParams(params) {
  const input = isRecord(params) ? params : {};
  const text = [
    input.target,
    input.address,
    input.community,
    input.building,
    input.unit,
    input.device,
    input.door
  ].filter((value) => typeof value === "string").join(" ");
  return sha256Hex(stableStringify({ tool: "door-open", text }));
}

export function checkDoorFastPathDedupe(params, now = Date.now(), scopeOverride = "") {
  const scope = scopeOverride || doorScopeFromParams(params);
  const last = recentScopes.get(scope);
  if (last && now - last < DEDUPE_MS) {
    return { allow: false, reason: "duplicate door request within 10 seconds", scope };
  }
  if (inflightScopes.has(scope)) {
    return { allow: false, reason: "door request already in progress", scope };
  }
  inflightScopes.add(scope);
  recentScopes.set(scope, now);
  return { allow: true, scope };
}

export function releaseDoorFastPathLock(scope) {
  if (scope) {
    inflightScopes.delete(scope);
  }
}

export function resetDoorFastPathStateForTest() {
  inflightScopes.clear();
  recentScopes.clear();
}

const registeredInflightScopes = new Set();
const registeredRecentScopes = new Map();

export function resetRegisteredSkillDedupeForTest() {
  registeredInflightScopes.clear();
  registeredRecentScopes.clear();
}

export function isRegisteredSkillFastPath(decision) {
  return decision?.action === "ALLOW" && decision?.path === "L1_REGISTERED_SKILL" && decision?.capability?.registeredSkill === true;
}

export function checkRegisteredSkillDedupe(decision, now = Date.now()) {
  const scope = String(decision?.conflictScope || "");
  const dedupeMs = Math.max(0, Number(decision?.capability?.skillExecution?.dedupeSeconds || 0) * 1000);
  if (!scope) return { allow: false, reason: "registered skill is missing a dedupe scope" };
  if (registeredInflightScopes.has(scope)) return { allow: false, reason: "registered skill is already in progress", scope };
  const last = registeredRecentScopes.get(scope);
  if (dedupeMs > 0 && last && now - last < dedupeMs) return { allow: false, reason: `registered skill duplicate within ${dedupeMs}ms`, scope };
  registeredInflightScopes.add(scope); registeredRecentScopes.set(scope, now);
  return { allow: true, scope };
}

export function releaseRegisteredSkillLock(scope) { if (scope) registeredInflightScopes.delete(scope); }

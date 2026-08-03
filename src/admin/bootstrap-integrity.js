import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export function integrityReport({ targetPath, hashPath }) {
  let target;
  try { target = readFileSync(targetPath); } catch (error) { return { enforcementMode: "WARN_ONLY", verificationResult: error?.code === "ENOENT" ? "TARGET_MISSING" : "TARGET_UNREADABLE", targetPath, hashPath }; }
  let raw;
  try { raw = readFileSync(hashPath, "utf8").trim(); } catch (error) { return { enforcementMode: "WARN_ONLY", verificationResult: error?.code === "ENOENT" ? "HASH_MISSING" : "HASH_UNREADABLE", targetPath, hashPath, actualHash: sha(target) }; }
  const expectedHash = raw.split(/\s+/)[0] || "";
  if (!/^[a-f0-9]{64}$/i.test(expectedHash)) return { enforcementMode: "WARN_ONLY", verificationResult: "INVALID_HASH_FORMAT", targetPath, hashPath, expectedHash, actualHash: sha(target) };
  const actualHash = sha(target);
  return { enforcementMode: "WARN_ONLY", verificationResult: expectedHash === actualHash ? "MATCH" : "MISMATCH", targetPath, hashPath, expectedHash, actualHash };
}

export function bootstrapComparison({ stagingPath, policyPath, targetPath, hashPath }) {
  const stagingFiles = files(stagingPath), formalFiles = files(policyPath, stagingPath);
  const all = [...new Set([...stagingFiles, ...formalFiles])].sort();
  const entries = all.map((path) => compare(path, stagingPath, policyPath));
  const hasLinks = entries.some((entry) => entry.staging?.link || entry.formal?.link);
  const differences = entries.filter((entry) => entry.result !== "IDENTICAL");
  const report = integrityReport({ targetPath, hashPath });
  const stagingConstitution = safeText(join(stagingPath, "security-constitution.md"));
  const formalConstitution = safeText(join(policyPath, "security-constitution.md"));
  const stagingHashMatchesStagingTarget = safeText(join(stagingPath, "integrity/security-constitution.sha256")).trim().split(/\s+/)[0] === sha(Buffer.from(stagingConstitution));
  const staleSemantics = /FAIL_CLOSED/.test(stagingConstitution) && /WARN_ONLY/.test(formalConstitution) && report.actualHash === sha(Buffer.from(formalConstitution));
  const classification = !differences.length && !hasLinks ? "IDENTICAL" : staleSemantics && stagingHashMatchesStagingTarget && !hasLinks ? "STALE" : "DIVERGED";
  return { classification, entries, integrity: report, staleEvidence: { stagingHashMatchesStagingTarget, stagingMode: /FAIL_CLOSED/.test(stagingConstitution) ? "FAIL_CLOSED" : "unknown", formalMode: /WARN_ONLY/.test(formalConstitution) ? "WARN_ONLY" : "unknown", formalMatchesRuntimeIntegrityTarget: report.actualHash === sha(Buffer.from(formalConstitution)) } };
}

function files(root, excluded = "") { if (!existsSync(root)) return []; const output = []; const walk = (current) => { for (const name of readdirSync(current)) { const absolute = join(current, name); if (excluded && absolute === excluded) continue; const info = lstatSync(absolute); if (info.isDirectory()) walk(absolute); else output.push(relative(root, absolute)); } }; walk(root); return output; }
function compare(path, staging, formal) { const left = describe(join(staging, path)), right = describe(join(formal, path)); return { path, staging: left, formal: right, result: left && right && !left.link && !right.link && left.hash === right.hash ? "IDENTICAL" : left && !right ? "STAGING_ONLY" : !left && right ? "FORMAL_ONLY" : "DIFFERENT" }; }
function describe(path) { if (!existsSync(path)) return null; const link = lstatSync(path).isSymbolicLink(); if (link) return { link: true }; const info = statSync(path); return { hash: sha(readFileSync(path)), size: info.size, mode: (info.mode & 0o777).toString(8), link: false }; }
function safeText(path) { try { return readFileSync(path, "utf8"); } catch { return ""; } }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }

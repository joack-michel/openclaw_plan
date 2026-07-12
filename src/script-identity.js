import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { sha256Hex, stableStringify } from "./canonical-json.js";

export function buildScriptIdentity({ cwd = "", executable = "", argv = [] }) {
  const normalizedCwd = canonicalPath(cwd || process.cwd());
  const scriptArg = firstScriptArg(argv);
  const scriptPath = scriptArg ? canonicalPath(resolve(normalizedCwd, expandHome(scriptArg))) : "";
  const identityCwd = scriptArg && isAbsolute(expandHome(scriptArg)) ? "" : normalizedCwd;
  const scriptIndex = argv.indexOf(scriptArg);
  const subcommandCandidate = scriptIndex >= 0 ? String(argv[scriptIndex + 1] || "") : "";
  const subcommand = /^[A-Za-z][A-Za-z0-9_-]*$/.test(subcommandCandidate) && !subcommandCandidate.startsWith("-") ? subcommandCandidate : "";
  const argvShape = argv.map((arg, index) => {
    if (index === 0 && arg === scriptArg) return "{script}";
    if (/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/.test(arg)) return arg;
    if (/^\d+$/.test(arg)) return "{number}";
    return "{value}";
  });
  const identity = {
    cwd: identityCwd,
    executable,
    scriptPath,
    subcommand,
    argvShape
  };
  return {
    ...identity,
    identityHash: sha256Hex(stableStringify(identity))
  };
}

export function commandResourceForScript(identity) {
  if (!identity?.identityHash) return "";
  return `script:${identity.identityHash}`;
}

function firstScriptArg(argv) {
  return (argv || []).find((arg) => /\.(?:js|mjs|cjs|ts|py|sh)$/i.test(String(arg || ""))) || "";
}

function canonicalPath(pathValue) {
  const expanded = expandHome(String(pathValue || ""));
  const absolute = resolve(expanded);
  if (!existsSync(absolute)) return absolute;
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function expandHome(pathValue) {
  return pathValue.startsWith("~/") ? resolve(homedir(), pathValue.slice(2)) : pathValue;
}


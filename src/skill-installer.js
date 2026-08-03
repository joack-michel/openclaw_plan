import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { NODE_EXECUTABLE, PYTHON_EXECUTABLE } from "./template-config.js";

const SAFE_INTERPRETERS = {
  node: [NODE_EXECUTABLE, "/usr/bin/node"],
  nodejs: [NODE_EXECUTABLE, "/usr/bin/node"],
  python: [PYTHON_EXECUTABLE],
  python3: [PYTHON_EXECUTABLE]
};
const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".py", ".sh"]);
const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".py", ".sh"]);
const FORBIDDEN = [
  [/child_process\s*\.\s*(?:exec|execSync)\b|\bexec(?:Sync)?\s*\(/, "dynamic process execution"],
  [/\b(?:spawn|spawnSync|execa)\s*\(/, "child-process spawning"],
  [/\beval\s*\(|\bFunction\s*\(/, "dynamic evaluation"],
  [/(?:bash|sh|node|python(?:3)?)\s+-[ce]\b/, "inline interpreter execution"],
  [/[|><`]|\$\(/, "shell operator or command substitution"],
  [/(?:curl|wget)[^\n]*(?:\||&&|;)[^\n]*(?:sh|bash|node|python)/i, "download then execute"],
  [/process\.env\s*\[|os\.environ\s*\[/, "dynamic environment access"],
  [/(?:writeFile|appendFile|unlink|rmSync|rmdir|mkdir|rename|chmod|os\.remove|shutil\.|open\([^\n]*,[^\n]*["'](?:w|a|x))/i, "file mutation"],
  [/(?:https?:\/\/|\bfetch\s*\(|\baxios\.|\brequests\.|\burllib\.|\bhttp\.request)/i, "network access"],
  [/(?:createOrder|payment|checkout|secret|credential|\.env\b|private.?key)/i, "sensitive or transactional capability"]
];

export function analyzeSkillDirectory(directory, { targetRoot, source = {} } = {}) {
  const root = resolve(directory);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return review("skill directory does not exist");
  const tree = walkTree(root);
  if (tree.error) return review(tree.error, tree.location);
  const files = tree.files;
  if (!files.includes("SKILL.md")) return review("SKILL.md is missing");
  const skillId = deriveSkillId(root, files);
  if (!skillId) return review("could not derive a safe skillId");
  const codeFiles = files.filter((file) => CODE_EXTENSIONS.has(extname(file)));
  const executableMetadata = files.filter((file) => ["package.json", "openclaw.plugin.json", "execution-manifest.json"].includes(file));
  if (codeFiles.length === 0 && executableMetadata.length === 0 && files.length === 1) {
    return {
      classification: "native-only",
      skillId,
      source: safeSource(source),
      files: hashes(root, files),
      contentHash: contentHash(root, files),
      reasons: [],
      manifest: null
    };
  }
  const scan = scanCode(root, codeFiles);
  if (scan) return review(scan.reason, scan.location, scan.shape);
  const entry = discoverFixedEntry(root, files);
  if (entry.error) return review(entry.error, entry.location, entry.shape);
  const targetDirectory = targetRoot ? join(resolve(targetRoot), skillId) : root;
  const manifest = buildManifest({ skillId, root, targetDirectory, entry, source, files });
  return {
    classification: "fixed-exec",
    skillId,
    source: safeSource(source),
    files: hashes(root, files),
    contentHash: contentHash(root, files),
    reasons: [],
    manifest
  };
}

export function buildManifest({ skillId, root, targetDirectory, entry, source, files }) {
  const script = join(targetDirectory, entry.scriptRelative);
  const executable = realInterpreter(entry.executable);
  const environment = extractEnvironment(root, files);
  return {
    schemaVersion: 1,
    skillId,
    description: descriptionFromSkill(root, skillId),
    enabled: true,
    agents: ["main"],
    invocation: { channels: [], actors: [] },
    capability: { name: capabilityFor(skillId), riskLevel: "L0" },
    entry: { executable, argv: [script, ...entry.args], cwd: targetDirectory },
    constraints: { allowExtraArgs: false, allowInlineEval: false, allowShellOperators: false, allowEnvironmentOverride: false, timeoutSeconds: 15 },
    execution: { dedupeKey: `${skillId}:exec`, dedupeSeconds: 10, maxAttempts: 1, retryOnUnknown: false },
    environment: { allow: environment, allowOverride: false },
    provenance: {
      sourceType: safeSource(source).sourceType || "local-directory",
      sourceLocation: safeSource(source).sourceLocation || root,
      sourceRevision: safeSource(source).sourceRevision || "",
      contentHash: contentHash(root, files),
      fileHashes: hashes(root, files)
    }
  };
}

export function capabilityFor(skillId) {
  return `SKILL_${skillId.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}_EXEC`;
}

export function safeSource(source = {}) {
  const sourceLocation = String(source.sourceLocation || "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(sourceLocation)) {
    try {
      const parsed = new URL(sourceLocation);
      if (parsed.username || parsed.password) return { rejected: "authenticated source URL is not allowed" };
    } catch {
      return { rejected: "invalid source URL" };
    }
  }
  return {
    sourceType: String(source.sourceType || ""),
    sourceLocation,
    sourceRevision: String(source.sourceRevision || "")
  };
}

function review(reason, location = "", shape = "") {
  return { classification: "review-required", reasons: [reason], location, shape, manifest: null };
}

function walkTree(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      if (name === ".git" || name === "node_modules") continue;
      const full = join(directory, name), info = lstatSync(full), rel = relative(root, full);
      if (info.isSymbolicLink()) return `symbolic links are not auto-installable: ${rel}`;
      if (info.isDirectory()) { const error = visit(full); if (error) return error; }
      else if (info.isFile()) files.push(rel);
      else return `unsupported filesystem entry: ${rel}`;
    }
    return "";
  };
  const error = visit(root);
  return { files: files.sort(), error };
}

function deriveSkillId(root, files) {
  for (const file of ["execution-manifest.json", "openclaw.plugin.json", "package.json"]) {
    if (!files.includes(file)) continue;
    try {
      const value = JSON.parse(readFileSync(join(root, file), "utf8"));
      const candidate = value.skillId || value.name || value.id;
      const normalized = normalizeSkillId(candidate);
      if (normalized) return normalized;
    } catch { return ""; }
  }
  return normalizeSkillId(basename(root));
}

function normalizeSkillId(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z][a-z0-9-]{2,62}$/.test(normalized) ? normalized : "";
}

function scanCode(root, files) {
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const [pattern, reason] of FORBIDDEN) {
      const found = text.match(pattern);
      if (found) return { reason: `detected ${reason}`, location: file, shape: found[0] };
    }
  }
  return null;
}

function discoverFixedEntry(root, files) {
  const candidates = [];
  if (files.includes("execution-manifest.json")) {
    try {
      const existing = JSON.parse(readFileSync(join(root, "execution-manifest.json"), "utf8"));
      const executable = existing?.entry?.executable, argv = existing?.entry?.argv;
      if (typeof executable === "string" && Array.isArray(argv) && argv.length) candidates.push({ executable, script: argv[0], args: argv.slice(1), location: "execution-manifest.json" });
    } catch { return { error: "execution-manifest.json is invalid", location: "execution-manifest.json" }; }
  }
  if (files.includes("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      if (typeof pkg?.scripts?.start === "string") { const parsed = parseFixedCommand(pkg.scripts.start); if (parsed.error) return { error: parsed.error, location: "package.json:scripts.start", shape: parsed.shape }; candidates.push({ ...parsed, location: "package.json:scripts.start" }); }
    } catch { return { error: "package.json is invalid", location: "package.json" }; }
  }
  const skill = readFileSync(join(root, "SKILL.md"), "utf8");
  for (const line of skill.split("\n")) {
    const trimmed = line.trim();
    if (/^(?:node|nodejs|python|python3|\/[^\s]+|bash|sh)\s+[^\s]+/.test(trimmed)) { const parsed = parseFixedCommand(trimmed); if (parsed.error) return { error: parsed.error, location: "SKILL.md", shape: parsed.shape }; candidates.push({ ...parsed, location: "SKILL.md" }); }
  }
  const usable = candidates.filter((candidate) => candidate.executable && candidate.script);
  if (usable.length !== 1) return { error: usable.length ? "multiple execution entrypoints require review" : "no fixed execution entrypoint found", location: usable[0]?.location || "SKILL.md" };
  const candidate = usable[0];
  if (!candidate || !candidate.executable || !candidate.script) return { error: "entrypoint uses unsafe shell syntax", location: candidate?.location || "" };
  if (!/^(node|nodejs|python|python3)$/.test(candidate.executable)) return { error: "only fixed Node or Python interpreter entrypoints are auto-installable", location: candidate.location, shape: candidate.executable };
  if (!SCRIPT_EXTENSIONS.has(extname(candidate.script))) return { error: "entrypoint must name a fixed script", location: candidate.location, shape: candidate.script };
  if (isAbsolute(candidate.script) || candidate.script.includes("..") || !existsSync(join(root, candidate.script))) return { error: "entrypoint script path must be an existing relative file", location: candidate.location, shape: candidate.script };
  if (candidate.args.some((arg) => !safeArgument(arg))) return { error: "entrypoint has dynamic or unsafe argv", location: candidate.location };
  return { executable: candidate.executable, scriptRelative: candidate.script, args: candidate.args, location: candidate.location };
}

function parseFixedCommand(command) {
  const text = String(command || "").trim();
  if (/[|><`;&$*?{}\[\]]|\$\(|\n|\r/.test(text) || /\s-[ce]\b/.test(text)) return { error: "detected dynamic Shell or inline interpreter execution", shape: text };
  const parts = text.split(/\s+/);
  return { executable: parts[0], script: parts[1], args: parts.slice(2) };
}

function safeArgument(value) { return typeof value === "string" && value.length > 0 && !/[\n\r*?{}\[\];|&`$]/.test(value); }
function realInterpreter(name) { for (const candidate of SAFE_INTERPRETERS[name] || []) if (existsSync(candidate)) return realpathSync(candidate); return ""; }
function descriptionFromSkill(root, skillId) { const first = readFileSync(join(root, "SKILL.md"), "utf8").split("\n").find((line) => line.trim() && !line.trim().startsWith("#")); return String(first || `Fixed entrypoint for ${skillId}`).slice(0, 240); }
function extractEnvironment(root, files) { const names = new Set(); for (const file of files.filter((item) => CODE_EXTENSIONS.has(extname(item)))) { const text = readFileSync(join(root, file), "utf8"); for (const match of text.matchAll(/(?:process\.env\.|os\.environ\.get\(["'])([A-Z][A-Z0-9_]{1,127})/g)) names.add(match[1]); } return [...names].sort(); }
function hashes(root, files) { return Object.fromEntries(files.map((file) => [file, createHash("sha256").update(readFileSync(join(root, file))).digest("hex")])); }
function contentHash(root, files) { return createHash("sha256").update(JSON.stringify(hashes(root, files))).digest("hex"); }

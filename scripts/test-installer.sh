#!/usr/bin/env bash
set -euo pipefail
umask 077

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/bin" "$tmp/user-root/.openclaw"
config="$tmp/user-root/.openclaw/openclaw.json"
printf '{"plugins":{"allow":["browser"],"load":{"paths":[]},"entries":{}}}\n' > "$config"

cat > "$tmp/bin/npm" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK

cat > "$tmp/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
case "$*" in
  *restart*) exit 0 ;;
  *is-active*) printf 'active\n'; exit 0 ;;
  *) exit 0 ;;
esac
MOCK

cat > "$tmp/bin/openclaw" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
config="${OPENCLAW_TEST_CONFIG:?}"
if [[ "${1:-}" == "--version" ]]; then printf 'OpenClaw test-fixture\n'; exit 0; fi
[[ "${1:-}" == "config" ]] || exit 2
case "${2:-}" in
  file) printf '%s\n' "$config" ;;
  get)
    path="${3:-}"
    node --input-type=module - "$config" "$path" <<'NODE'
import fs from "node:fs";
const [file, path] = process.argv.slice(2);
let value = JSON.parse(fs.readFileSync(file, "utf8"));
for (const key of path.split(".")) value = value?.[key];
process.stdout.write(`${JSON.stringify(value ?? [])}\n`);
NODE
    ;;
  patch)
    [[ "${3:-}" == "--file" ]] || exit 2
    patch="${4:-}"
    dry=false
    [[ "${5:-}" != "--dry-run" ]] || dry=true
    node --input-type=module - "$config" "$patch" "$dry" <<'NODE'
import fs from "node:fs";
const [file, patchFile, dryRaw] = process.argv.slice(2);
const merge = (left, right) => {
  if (!right || typeof right !== "object" || Array.isArray(right)) return right;
  const out = left && typeof left === "object" && !Array.isArray(left) ? structuredClone(left) : {};
  for (const [key, value] of Object.entries(right)) out[key] = merge(out[key], value);
  return out;
};
const next = merge(JSON.parse(fs.readFileSync(file, "utf8")), JSON.parse(fs.readFileSync(patchFile, "utf8")));
if (dryRaw !== "true") fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
NODE
    ;;
  validate) node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' "$config" ;;
  *) exit 2 ;;
esac
MOCK

chmod +x "$tmp/bin/npm" "$tmp/bin/systemctl" "$tmp/bin/openclaw"
PATH="$tmp/bin:$PATH" \
HOME="$tmp/user-root" \
OPENCLAW_TEST_CONFIG="$config" \
bash "$root/install.sh" --apply >/dev/null

node --input-type=module - "$config" "$root" <<'NODE'
import fs from "node:fs";
const [file, root] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(file, "utf8"));
if (!config.plugins.allow.includes("execution-gate")) throw new Error("plugin allow entry missing");
if (!config.plugins.load.paths.includes(root)) throw new Error("plugin load path missing");
if (config.plugins.entries["execution-gate"]?.config?.operationTtlMs !== 600000) throw new Error("plugin config missing");
NODE

printf 'installer-test: apply and verification passed\n'

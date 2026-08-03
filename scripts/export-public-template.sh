#!/usr/bin/env bash
set -euo pipefail
umask 077

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:?usage: export-public-template.sh OUTPUT_DIR}"
test ! -e "$output" || { printf 'Output directory already exists; refusing to merge.\n' >&2; exit 1; }
mkdir -p "$output"

for path in src test sql bin scripts config policy examples docs install.sh package.json openclaw.plugin.json .env.example .gitignore README.md SECURITY.md SANITIZATION.md CHANGELOG.md LICENSE; do
  cp -R "$source_dir/$path" "$output/"
done
bash "$output/scripts/verify-public-template.sh" --release --skip-tests
printf 'Allowlist export completed: %s\n' "$output"

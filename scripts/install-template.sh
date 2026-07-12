#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-${HOME}/openclaw-execution-gate}"
mkdir -p "$target"
target="$(cd "$target" && pwd)"
case "$target" in
  "$repo_dir"|"$repo_dir"/*) printf 'Refusing to install into the template Git working tree. Choose a separate runtime directory.\n' >&2; exit 1 ;;
esac
for path in src sql config policy examples docs scripts package.json openclaw.plugin.json README.md SECURITY.md SANITIZATION.md LICENSE .env.example .gitignore; do
  cp -R "$repo_dir/$path" "$target/"
done
printf 'Installed sanitized template into %s\n' "$target"


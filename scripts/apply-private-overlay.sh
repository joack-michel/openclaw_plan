#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
overlay="${PRIVATE_OVERLAY_DIR:-${repo_dir}/private-overlay}"
target="${1:?usage: apply-private-overlay.sh DEPLOYMENT_DIR}"
target="$(mkdir -p "$target" && cd "$target" && pwd)"

case "$target" in
  "$repo_dir"|"$repo_dir"/*) printf 'Refusing to apply private files inside the Git working tree.\n' >&2; exit 1 ;;
esac
test -d "$overlay" || { printf 'Private overlay is missing.\n' >&2; exit 1; }

count=0
while IFS= read -r -d '' file; do
  relative="${file#${overlay}/}"
  destination="${target}/${relative}"
  mkdir -p "$(dirname "$destination")"
  install -m 600 "$file" "$destination"
  count=$((count + 1))
done < <(find "$overlay" -type f -print0)
printf 'Applied %d private files with mode 0600. Secret values were not printed.\n' "$count"


#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
payload="$root/archive/remaining-files.tgz.b64"

test -f "$payload" || { printf 'Missing archive payload: %s\n' "$payload" >&2; exit 1; }
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT HUP INT TERM
base64 -d "$payload" > "$tmp"
tar -xzf "$tmp" -C "$root"
printf 'Restored remaining sanitized source and test files.\n'

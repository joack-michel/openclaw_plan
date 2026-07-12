#!/usr/bin/env bash
set -euo pipefail
umask 077

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
template="$tmp/template"
mkdir -p "$template"
tar -C "$root" --exclude=.git -cf - . | tar -C "$template" -xf -

pass() { printf 'verify-negative: %s\n' "$1"; }
expect_fail() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'Expected failure: %s\n' "$label" >&2
    exit 1
  fi
  pass "$label"
}
expect_fail_rule() {
  local label="$1" rule="$2"
  shift 2
  local output="$tmp/$label.out"
  if "$@" >"$output" 2>&1; then
    printf 'Expected failure: %s\n' "$label" >&2
    exit 1
  fi
  grep -Fq "rule=$rule" "$output" || { printf 'Expected rule %s for %s\n' "$rule" "$label" >&2; exit 1; }
  pass "$label"
}

prefix=Bear; prefix+=er; value=test; value+=-secret-value
printf '%s %s\n' "$prefix" "$value" > "$template/current-secret.txt"
expect_fail current-file-secret bash "$template/scripts/verify-public-template.sh" --skip-tests
rm "$template/current-secret.txt"

(cd "$template" && git init -q && git config user.name "Template Test" && git config user.email "template@example.invalid" && git add . && git commit -qm "base")
bash "$template/scripts/verify-public-template.sh" --skip-tests >/dev/null
pass clean-git-history-and-env-example

(cd "$template" && printf '%s %s\n' "$prefix" "$value" > history-secret.txt && git add history-secret.txt && git commit -qm "fixture secret" && rm history-secret.txt && git add -u && git commit -qm "remove fixture secret")
expect_fail git-history-secret bash "$template/scripts/verify-public-template.sh" --skip-tests

rm -rf "$template/.git"
mkdir -p "$template/private-overlay"
key=TO; key+=KEN; overlay_value=short; overlay_value+=-fixture
printf '%s=%s\n' "$key" "$overlay_value" > "$template/private-overlay/.env"
bash "$template/scripts/verify-public-template.sh" --skip-tests >/dev/null
pass untracked-private-overlay-normal-mode
expect_fail private-overlay-release-mode bash "$template/scripts/verify-public-template.sh" --release --skip-tests

(cd "$template" && git init -q && git config user.name "Template Test" && git config user.email "template@example.invalid" && git add . && git commit -qm "base" && printf 'X=1\n' > private-overlay/local.txt && git add -f private-overlay/local.txt && git commit -qm "fixture tracked overlay")
expect_fail_rule committed-private-overlay forbidden-tracked-path bash "$template/scripts/verify-public-template.sh" --skip-tests
pass placeholders-allowed


#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
failures=0
check() {
  local rule="$1" pattern="$2"
  while IFS=: read -r file line _; do
    test -n "$file" || continue
    printf '[FAIL] %s: rule=%s line=%s redacted\n' "${file#"$root"/}" "$rule" "$line" >&2
    failures=$((failures + 1))
  done < <(grep -aRInE --exclude-dir=.git --exclude='remaining-files.tgz.b64' --exclude='verify-private-data.sh' --exclude='SANITIZATION.md' "$pattern" "$root" 2>/dev/null || true)
}
check "credential-url" 'https?://[^/@[:space:]]+:[^/@[:space:]]+@'
check "phone-or-account" '(^|[^0-9])([+]?[1-9][0-9]{7,14})([^0-9]|$)'
check "physical-location" '[0-9]+(幢|栋|单元|室|号楼)'
check "money-value" '([¥￥][[:space:]]*[0-9]|[$][[:space:]]*[0-9]+([.][0-9]{2})?([[:space:]]|$)|[0-9]+([.][0-9]+)?[[:space:]]*(元|人民币|美元))'
check "utility-value" '([0-9]+([.][0-9]+)?[[:space:]]*(kWh|度电)|电费[：:=]?[[:space:]]*[0-9]|电量[：:=]?[[:space:]]*[0-9])'
if test "$failures" -ne 0; then
  printf 'Private-data verification failed: %d finding(s). Values were not printed.\n' "$failures" >&2
  exit 1
fi
printf 'Private-data verification passed.\n'

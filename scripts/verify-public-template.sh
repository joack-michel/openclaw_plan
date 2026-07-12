#!/usr/bin/env bash
set -euo pipefail
umask 077

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release=false
skip_tests=false
for arg in "$@"; do
  case "$arg" in
    --release) release=true ;;
    --skip-tests) skip_tests=true ;;
    *) printf 'usage: %s [--release] [--skip-tests]\n' "$0" >&2; exit 2 ;;
  esac
done

tmp="$(mktemp -d)"
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
failures=0

report() {
  local source="$1" rule="$2" line="${3:-0}" commit="${4:-working-tree}"
  printf '[FAIL] %s: rule=%s line=%s commit=%s redacted\n' "$source" "$rule" "$line" "$commit"
  failures=$((failures + 1))
}

line_matches() {
  local file="$1" source="$2" rule="$3" pattern="$4" commit="${5:-working-tree}"
  while IFS=: read -r line content; do
    test -n "$line" || continue
    report "$source" "$rule" "$line" "$commit"
  done < <(grep -aInE "$pattern" "$file" 2>/dev/null || true)
}

line_matches_filtered() {
  local file="$1" source="$2" rule="$3" pattern="$4" commit="$5" allow="$6"
  while IFS=: read -r line content; do
    test -n "$line" || continue
    [[ "$content" =~ $allow ]] && continue
    report "$source" "$rule" "$line" "$commit"
  done < <(grep -aInE "$pattern" "$file" 2>/dev/null || true)
}

scan_file() {
  local file="$1" source="$2" commit="${3:-working-tree}"
  test -s "$file" || return 0
  grep -Iq . "$file" || { report "$source" "unknown-binary" 0 "$commit"; return 0; }

  line_matches "$file" "$source" "private-key" 'BEGIN[[:space:]]+(RSA[[:space:]]+|OPENSSH[[:space:]]+)?PRIVATE[[:space:]]+KEY' "$commit"
  line_matches "$file" "$source" "bearer-token" 'Bearer[[:space:]]+[A-Za-z0-9._~+/-]{12,}' "$commit"
  line_matches "$file" "$source" "credential-assignment" "([\"'](Authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|bot[_-]?token|password|passwd|secret|cookie|session|private[_-]?key|webhook|token)[\"'][[:space:]]*:[[:space:]]*[\"']?[^<[:space:]\"']{12,}|(AUTHORIZATION|API[_-]?KEY|APIKEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|BOT[_-]?TOKEN|PASSWORD|PASSWD|SECRET|COOKIE|SESSION|PRIVATE[_-]?KEY|WEBHOOK|TOKEN)[[:space:]]*=[[:space:]]*[^<[:space:]]{12,})" "$commit"
  line_matches "$file" "$source" "credential-url-parameter" 'https?://[^[:space:]]+[?&](token|key|secret|auth|password)=[^<[:space:]&]{8,}' "$commit"
  line_matches "$file" "$source" "absolute-home-path" '/home/[A-Za-z0-9._-]+/' "$commit"
  line_matches_filtered "$file" "$source" "email-address" '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$commit" '[A-Za-z0-9._%+-]+@example\.invalid'
  line_matches_filtered "$file" "$source" "ipv4-address" '([0-9]{1,3}\.){3}[0-9]{1,3}' "$commit" '(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)'
  line_matches_filtered "$file" "$source" "long-numeric-account-id" '(^|[^0-9])[0-9]{8,}([^0-9]|$)' "$commit" '00000000-0000-4000-8000-000000000000'
  line_matches_filtered "$file" "$source" "uuid" '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}' "$commit" '00000000-0000-4000-8000-000000000000'

  if test -n "${SANITIZE_DENYLIST_FILE:-}"; then
    while IFS= read -r value; do
      test -n "$value" || continue
      if grep -aFq -- "$value" "$file"; then
        report "$source" "denylist-match" 0 "$commit"
      fi
    done < "$SANITIZE_DENYLIST_FILE"
  fi
}

if test -n "${SANITIZE_DENYLIST_FILE:-}"; then
  test -f "$SANITIZE_DENYLIST_FILE" || { printf 'Denylist file not found.\n' >&2; exit 2; }
  case "$(cd "$(dirname "$SANITIZE_DENYLIST_FILE")" && pwd)/$(basename "$SANITIZE_DENYLIST_FILE")" in
    "$root"/*) printf 'Denylist file must remain outside the public repository.\n' >&2; exit 2 ;;
  esac
fi

if $release && test -e "$root/private-overlay"; then
  report "private-overlay" "release-private-overlay" 0
fi

while IFS= read -r file; do
  relative="${file#"$root"/}"
  case "$relative" in
    .git/*|private-overlay/*) $release || continue ;;
  esac
  scan_file "$file" "$relative"
done < <(find "$root" -type f -print)

while IFS= read -r file; do report "${file#"$root"/}" "forbidden-runtime-file" 0; done < <(find "$root" -type f \( -name '.env' -o -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.db' -o -name '*.db-*' -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name '*.cookie' -o -name '*.cookies' -o -name '*.session' -o -name '*.token' -o -name '*.secret' -o -name '*.log' -o -name '*.bak' -o -name '*.backup' \) ! -path "$root/private-overlay/*" ! -name '.env.example' -print)
while IFS= read -r file; do report "${file#"$root"/}" "forbidden-archive" 0; done < <(find "$root" -type f \( -name '*.zip' -o -name '*.tar' -o -name '*.tgz' -o -name '*.gz' -o -name '*.bz2' -o -name '*.xz' -o -name '*.7z' -o -name '*.rar' \) -print)
if $release; then
  while IFS= read -r dir; do report "${dir#"$root"/}" "release-private-directory" 0; done < <(find "$root" -type d \( -name private-overlay -o -name secrets -o -name credentials -o -name backups -o -name state -o -name sessions -o -name logs \) ! -path "$root/.git/*" -print)
fi

git_root="$(git -C "$root" rev-parse --show-toplevel 2>/dev/null || true)"
if test "$git_root" = "$root"; then
  while IFS= read -r path; do
    case "$path" in
      .env.example) ;;
      .env|.env.*|private-overlay/*|secrets/*|credentials/*|backups/*|state/*|sessions/*|logs/*|tmp/*|cache/*|*.sqlite|*.sqlite3|*.db|*.db-*|*.sqlite-wal|*.sqlite-shm|*.pem|*.key|*.p12|*.pfx|*.cookie|*.cookies|*.session|*.token|*.secret|*.log|*.bak|*.backup)
        report "tracked:$path" "forbidden-tracked-path" 0 "tracked"; continue ;;
    esac
    object="$tmp/tracked-object"
    git -C "$root" show ":$path" > "$object" 2>/dev/null || continue
    chmod 600 "$object"
    scan_file "$object" "tracked:$path" "tracked"
  done < <(git -C "$root" ls-files)

  while IFS=' ' read -r object type; do
    test "$type" = "blob" || continue
    blob="$tmp/object-$object"
    git -C "$root" cat-file blob "$object" > "$blob"
    chmod 600 "$blob"
    scan_file "$blob" "git-object:$object" "$object"
  done < <(git -C "$root" cat-file --batch-all-objects --batch-check='%(objectname) %(objecttype)')
fi

if ! $skip_tests; then
  (cd "$root" && npm test)
  (cd "$root" && npm run build)
fi

if test "$failures" -ne 0; then
  printf 'Verification failed: %d finding(s); values were redacted.\n' "$failures" >&2
  exit 1
fi
printf 'Verification passed: worktree, index, and recoverable Git objects are clear.\n'


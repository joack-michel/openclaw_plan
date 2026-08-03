#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ACTION="plan"
PATCH_UI="false"
SERVICE_NAME="${OPENCLAW_GATEWAY_SERVICE:-openclaw-gateway.service}"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ID="execution-gate"
TMP_DIR=""
CONFIG_PATH=""
BACKUP_PATH=""
CONFIG_APPLIED="false"

usage() {
  cat <<'USAGE'
OpenClaw Execution Gate installer

Usage:
  bash install.sh --plan [--patch-ui]
  bash install.sh --apply [--patch-ui]

Options:
  --plan       Run checks and preview the configuration change. Default.
  --apply      Apply configuration, restart Gateway, and verify it.
  --patch-ui   Apply the version-specific Chinese approval UI patch.
  -h, --help   Show this help.
USAGE
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
need_command() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

cleanup() {
  if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then rm -rf -- "$TMP_DIR"; fi
}

rollback_config() {
  if [[ "$CONFIG_APPLIED" != "true" || -z "$BACKUP_PATH" || ! -f "$BACKUP_PATH" ]]; then return; fi
  warn "installation failed after changing OpenClaw configuration"
  warn "restoring configuration backup"
  cp -p -- "$BACKUP_PATH" "$CONFIG_PATH" || true
  openclaw config validate >/dev/null 2>&1 || true
  systemctl --user restart "$SERVICE_NAME" >/dev/null 2>&1 || true
}

on_error() {
  local status=$?
  rollback_config
  exit "$status"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan) ACTION="plan"; shift ;;
    --apply) ACTION="apply"; shift ;;
    --patch-ui) PATCH_UI="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

trap cleanup EXIT HUP INT TERM

[[ "$(uname -s)" == "Linux" ]] || die "this installer currently supports Linux only"
[[ "${EUID:-$(id -u)}" -ne 0 ]] || die "run as the OpenClaw service user, not root"

need_command git
need_command node
need_command npm
need_command openclaw
need_command systemctl

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node.js 22 or newer is required"

for required in \
  package.json \
  openclaw.plugin.json \
  src/index.js \
  src/operation-bus.js \
  src/operation-store.js \
  test/operation-bus.test.js
do
  [[ -f "$ROOT/$required" ]] || die "incomplete public source: missing $required"
done

CONFIG_PATH="$(openclaw config file 2>/dev/null | tail -n 1)"
[[ -n "$CONFIG_PATH" ]] || die "could not resolve the active OpenClaw config"
[[ -f "$CONFIG_PATH" ]] || die "OpenClaw config does not exist: $CONFIG_PATH"

OPENCLAW_VERSION="$(openclaw --version 2>/dev/null | head -n 1 || true)"

info "repository: $ROOT"
info "OpenClaw: ${OPENCLAW_VERSION:-unknown}"
info "Node.js: $(node --version)"
info "config: $CONFIG_PATH"

cd "$ROOT"
info "running tests"
npm test
info "running build checks"
npm run build
info "running public release verification"
npm run verify

ALLOW_JSON="$(openclaw config get plugins.allow --json 2>/dev/null || printf '[]')"
LOAD_PATHS_JSON="$(openclaw config get plugins.load.paths --json 2>/dev/null || printf '[]')"

TMP_DIR="$(mktemp -d)"
PATCH_PATH="$TMP_DIR/openclaw-execution-gate.patch.json"

node --input-type=module - "$ALLOW_JSON" "$LOAD_PATHS_JSON" "$ROOT" "$PATCH_PATH" <<'NODE'
import fs from "node:fs";

const [allowRaw, loadPathsRaw, root, outputPath] = process.argv.slice(2);
function array(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
const allow = [...new Set([...array(allowRaw), "execution-gate"])];
const paths = [...new Set([...array(loadPathsRaw), root])];
const patch = {
  plugins: {
    allow,
    load: { paths },
    entries: {
      "execution-gate": {
        enabled: true,
        config: {
          enabled: true,
          dbPath: "~/.openclaw/state/execution-gate.sqlite",
          operationTtlMs: 600000,
          executionTimeoutMs: 120000
        }
      }
    }
  }
};
fs.writeFileSync(outputPath, `${JSON.stringify(patch, null, 2)}\n`, { mode: 0o600 });
NODE

info "validating the generated config patch"
openclaw config patch --file "$PATCH_PATH" --dry-run >/dev/null

cat <<PLAN

Installation plan
-----------------
Repository:
  $ROOT

OpenClaw config:
  $CONFIG_PATH

Plugin:
  $PLUGIN_ID

Changes:
  - add the repository to plugins.load.paths
  - add execution-gate to plugins.allow
  - enable the execution-gate plugin
  - configure a private SQLite state path
  - validate the complete OpenClaw configuration
  - restart $SERVICE_NAME
  - verify that Gateway is active

Chinese UI patch:
  $PATCH_UI
PLAN

if [[ "$ACTION" == "plan" ]]; then
  printf '\nPLAN ONLY: no configuration or service was changed.\n'
  exit 0
fi

STATE_ROOT="${OPENCLAW_STATE_DIR:-$HOME/.openclaw/state}"
BACKUP_DIR="$STATE_ROOT/execution-gate-installer/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p -- "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
BACKUP_PATH="$BACKUP_DIR/openclaw.json"
cp -p -- "$CONFIG_PATH" "$BACKUP_PATH"
chmod 600 "$BACKUP_PATH"
info "configuration backup created"

trap on_error ERR
info "applying OpenClaw configuration"
openclaw config patch --file "$PATCH_PATH"
CONFIG_APPLIED="true"
info "validating OpenClaw configuration"
openclaw config validate
info "restarting Gateway"
systemctl --user restart "$SERVICE_NAME"
info "checking Gateway status"
systemctl --user is-active --quiet "$SERVICE_NAME"
trap - ERR

if [[ "$PATCH_UI" == "true" ]]; then
  info "attempting the version-specific Chinese approval UI patch"
  if OPENCLAW_LAUNCHER="$(command -v openclaw)" npm run patch:approval-ui; then
    systemctl --user restart "$SERVICE_NAME"
    systemctl --user is-active --quiet "$SERVICE_NAME"
    info "Chinese approval UI patch applied"
  else
    warn "core plugin installation succeeded, but the UI patch was not compatible"
  fi
fi

printf '\nINSTALLATION COMPLETE\n'
printf 'Plugin path: %s\n' "$ROOT"
printf 'Config backup: %s\n' "$BACKUP_PATH"
printf 'Gateway: active\n'

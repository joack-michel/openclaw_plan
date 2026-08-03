#!/usr/bin/env bash
set -euo pipefail
umask 077

fixture_root="/tmp/openclaw-template-user"
openclaw_home="$fixture_root/.openclaw"
workspace="$openclaw_home/workspace"
gate_home="$fixture_root/openclaw-execution-gate"

rm -rf "$fixture_root"
mkdir -p \
  "$workspace/policy" \
  "$workspace/memory/topics" \
  "$workspace/memory/.learnings" \
  "$openclaw_home/skills" \
  "$openclaw_home/agents" \
  "$gate_home"

printf '# Public test memory\n' > "$workspace/MEMORY.md"
printf 'fixture\n' > /tmp/example
mkdir -p "$gate_home/src"
printf '{\"name\":\"fixture-gate\",\"scripts\":{\"test\":\"node --test\"}}\n' > "$gate_home/package.json"
printf 'export default {};\n' > "$gate_home/src/index.js"

OPENCLAW_HOME="$openclaw_home" \
OPENCLAW_WORKSPACE="$workspace" \
EXECUTION_GATE_HOME="$gate_home" \
TELEGRAM_USER_ID="1000000" \
REM_CRON_JOB_ID="rem-job" \
MEITUAN_CRON_JOB_ID="meituan-job" \
BENEFITS_PARENT_CRON_JOB_ID="benefits-job" \
BENEFITS_AGENT_ID="benefits-orchestrator" \
node --test --test-concurrency=1 \
  test/operation-bus.test.js \
  test/transparent-runtime.test.js \
  test/scoped-time-window.test.js \
  test/cron-approval-bypass.test.js \
  test/mcp-schema.test.js

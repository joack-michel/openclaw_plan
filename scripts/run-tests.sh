#!/usr/bin/env bash
set -euo pipefail

fixture_root="/tmp/openclaw-template-user"
openclaw_home="$fixture_root/.openclaw"
workspace="$openclaw_home/workspace"
gate_home="$fixture_root/openclaw-execution-gate"

mkdir -p \
  "$workspace/policy" \
  "$workspace/memory/topics" \
  "$workspace/memory/.learnings" \
  "$openclaw_home/skills" \
  "$openclaw_home/agents" \
  "$gate_home"

OPENCLAW_HOME="$openclaw_home" \
OPENCLAW_WORKSPACE="$workspace" \
EXECUTION_GATE_HOME="$gate_home" \
TELEGRAM_USER_ID="1000000" \
REM_CRON_JOB_ID="rem-job" \
MEITUAN_CRON_JOB_ID="meituan-job" \
BENEFITS_PARENT_CRON_JOB_ID="benefits-job" \
node --test test/*.test.js

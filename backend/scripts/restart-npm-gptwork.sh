#!/bin/bash
# restart-npm-gptwork.sh — Detached npm restart for GPTWork
#
# Schedules a controlled restart of GPTWork via npm.
# Used by the safe-restart-detached-scheduler when restart_mode=npm.
#
# Usage:
#   ./restart-npm-gptwork.sh [--cwd DIR] [--log FILE]
#
# Options:
#   --cwd DIR   Backend directory (default: /home/a9017/mcp/workspace/gpt-codex-workspace/backend)
#   --log FILE  Log file path (default: <cwd>/../.gptwork/logs/gptwork-npm-restart.log)

set -euo pipefail

CWD="/home/a9017/mcp/workspace/gpt-codex-workspace/backend"
LOG_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd) CWD="$2"; shift 2 ;;
    --log) LOG_FILE="$2"; shift 2 ;;
    *) echo "[restart-npm-gptwork] Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Default log path relative to cwd parent
if [[ -z "$LOG_FILE" ]]; then
  LOG_DIR="$(cd "$CWD/.." 2>/dev/null && pwd)/.gptwork/logs"
  LOG_FILE="${LOG_DIR}/gptwork-npm-restart.log"
fi

mkdir -p "$(dirname "$LOG_FILE")" || true

# Wait briefly for old process to fully exit
sleep 2

{
  echo ""
  echo "=== GPTWork npm restart at $(date) ==="
  echo "CWD: $CWD"
  echo "PID: $$"
} >> "$LOG_FILE"

cd "$CWD" || { echo "[restart-npm-gptwork] Failed to cd to $CWD" >> "$LOG_FILE"; exit 1; }

# Start GPTWork via npm in background
nohup npm run start >> "$LOG_FILE" 2>&1 &
NEW_PID=$!

{
  echo "Started new GPTWork process with PID: $NEW_PID"
  echo "=== Restart complete ==="
} >> "$LOG_FILE"

# Disown so shell exit does not affect it
disown "$NEW_PID" 2>/dev/null || true

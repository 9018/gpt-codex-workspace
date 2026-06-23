#!/bin/bash
# restart-npm-gptwork.sh — Detached npm restart for GPTWork
#
# Schedules a controlled restart of GPTWork via npm.
# Kills the OLD process before starting the new one so the port is freed.
#
# Usage:
#   ./restart-npm-gptwork.sh --cwd DIR --pid OLD_PID [--log FILE]
#
# Options:
#   --cwd DIR   Backend directory (default: /home/a9017/mcp/workspace/gpt-codex-workspace/backend)
#   --pid PID   PID of the old GPTWork process (required for proper restart)
#   --log FILE  Log file path (default: <cwd>/../.gptwork/logs/gptwork-npm-restart.log)

set -euo pipefail

CWD="/home/a9017/mcp/workspace/gpt-codex-workspace/backend"
OLD_PID=""
LOG_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cwd) CWD="$2"; shift 2 ;;
    --pid) OLD_PID="$2"; shift 2 ;;
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

{
  echo ""
  echo "=== GPTWork npm restart at $(date) ==="
  echo "CWD: $CWD"
  echo "Script PID: $$"
  echo "Old PID: ${OLD_PID:-"(not provided)"}"
} >> "$LOG_FILE"

# Wait for the current request to finish
sleep 3

# Kill the old GPTWork process so the new one can bind the port
if [[ -n "$OLD_PID" ]]; then
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Gracefully stopping old GPTWork PID $OLD_PID..." >> "$LOG_FILE"
    kill "$OLD_PID" 2>> "$LOG_FILE" || true
    sleep 2
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "Force killing old GPTWork PID $OLD_PID..." >> "$LOG_FILE"
      kill -9 "$OLD_PID" 2>> "$LOG_FILE" || true
      sleep 1
    fi
    echo "Old GPTWork PID $OLD_PID stopped." >> "$LOG_FILE"
  else
    echo "Old GPTWork PID $OLD_PID already gone." >> "$LOG_FILE"
  fi
else
  echo "WARNING: No old PID provided — old GPTWork process may still be running!" >> "$LOG_FILE"
fi

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

#!/usr/bin/env bash
#
# acceptance-workflow.sh — GPTChat acceptance flow CLI
#
# Builds an acceptance bundle from task artifacts and submits it for
# GPTChat review, or ingests a GPTChat response back into the system.
#
# Usage:
#   # Submit task for GPTChat acceptance review
#   ./scripts/acceptance-workflow.sh submit --task-id <task_id>
#
#   # Ingest GPTChat response (after review)
#   ./scripts/acceptance-workflow.sh ingest --task-id <task_id> --response-file <path>
#
#   # Quick submit + ingest (for testing)
#   ./scripts/acceptance-workflow.sh auto --task-id <task_id> --response-file <path>
#
#   # Build bundle only (no GPTChat submission)
#   ./scripts/acceptance-workflow.sh bundle --task-id <task_id> [--output <path>]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/../backend"

help() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | head -n -1
  exit 0
}

[[ $# -lt 1 ]] && help

COMMAND="$1"
shift

case "$COMMAND" in
  submit)
    TASK_ID=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --task-id) TASK_ID="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
      esac
    done
    if [[ -z "$TASK_ID" ]]; then echo "Error: --task-id is required"; exit 1; fi
    exec node "$BACKEND_DIR/src/cli.mjs" gptchat-acceptance submit --task-id "$TASK_ID"
    ;;
  ingest)
    TASK_ID=""
    RESPONSE_FILE=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --task-id) TASK_ID="$2"; shift 2 ;;
        --response-file) RESPONSE_FILE="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
      esac
    done
    if [[ -z "$TASK_ID" ]]; then echo "Error: --task-id is required"; exit 1; fi
    if [[ -z "$RESPONSE_FILE" ]]; then echo "Error: --response-file is required"; exit 1; fi
    if [[ ! -f "$RESPONSE_FILE" ]]; then echo "Error: response file not found: $RESPONSE_FILE"; exit 1; fi
    RESPONSE_TEXT=$(cat "$RESPONSE_FILE")
    exec node "$BACKEND_DIR/src/cli.mjs" gptchat-acceptance ingest --task-id "$TASK_ID" --response "$RESPONSE_TEXT"
    ;;
  auto)
    TASK_ID=""
    RESPONSE_FILE=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --task-id) TASK_ID="$2"; shift 2 ;;
        --response-file) RESPONSE_FILE="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
      esac
    done
    if [[ -z "$TASK_ID" ]]; then echo "Error: --task-id is required"; exit 1; fi
    if [[ -z "$RESPONSE_FILE" ]]; then echo "Error: --response-file is required"; exit 1; fi
    if [[ ! -f "$RESPONSE_FILE" ]]; then echo "Error: response file not found: $RESPONSE_FILE"; exit 1; fi
    RESPONSE_TEXT=$(cat "$RESPONSE_FILE")
    exec node "$BACKEND_DIR/src/cli.mjs" gptchat-acceptance auto --task-id "$TASK_ID" --response "$RESPONSE_TEXT"
    ;;
  bundle)
    TASK_ID=""
    OUTPUT=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --task-id) TASK_ID="$2"; shift 2 ;;
        --output) OUTPUT="--output $2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
      esac
    done
    if [[ -z "$TASK_ID" ]]; then echo "Error: --task-id is required"; exit 1; fi
    exec node "$BACKEND_DIR/src/cli.mjs" gptchat-acceptance bundle --task-id "$TASK_ID" $OUTPUT
    ;;
  help|--help|-h)
    help
    ;;
  *)
    echo "Unknown command: $COMMAND"
    echo ""
    help
    ;;
esac

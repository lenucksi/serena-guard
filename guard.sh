#!/usr/bin/env bash
# PreToolUse hook — blocks Read/Edit/Write/Grep/Bash on code files and
# redirects to the correct Serena/LSP tool with a pre-filled call.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

input=$(cat)

export HOOK_TOOL HOOK_FP HOOK_CMD HOOK_INPUT HOOK_DIR
HOOK_TOOL=$(jq -r '.tool_name'                                    <<< "$input")
HOOK_FP=$(jq -r '.tool_input.file_path // .tool_input.path // ""' <<< "$input")
HOOK_CMD=$(jq -r '.tool_input.command // ""'                       <<< "$input")
HOOK_INPUT=$(jq -c '.tool_input'                                   <<< "$input")
HOOK_DIR="$DIR"

if command -v bun &>/dev/null; then
  exec bun run "$DIR/claude-hook.ts"
elif command -v npx &>/dev/null; then
  exec npx tsx "$DIR/claude-hook.ts"
else
  exec node "$DIR/claude-hook.js"
fi

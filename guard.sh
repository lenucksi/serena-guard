#!/usr/bin/env bash
# PreToolUse hook — blocks Read/Edit/Write/Grep/Bash on code files and
# redirects Claude to the correct Serena/LSP tool with a pre-filled call.
# Registered in ~/.claude/settings.json (user-global, applies to all projects).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

input=$(cat)

export HOOK_TOOL HOOK_FP HOOK_CMD HOOK_INPUT SERENA_EXT_CONFIG
HOOK_TOOL=$(jq -r '.tool_name'                                    <<< "$input")
HOOK_FP=$(jq -r '.tool_input.file_path // .tool_input.path // ""' <<< "$input")
HOOK_CMD=$(jq -r '.tool_input.command // ""'                       <<< "$input")
HOOK_INPUT=$(jq -c '.tool_input'                                   <<< "$input")
SERENA_EXT_CONFIG="$DIR/extensions.yaml"

python3 "$DIR/check.py"

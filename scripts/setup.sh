#!/usr/bin/env bash
# setup.sh — Register serena-guard in central Claude Code and OpenCode configs.
# Run once after cloning the repo.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}::${NC} $1"; }
ok()    { echo -e "${GREEN}ok${NC} $1"; }
warn()  { echo -e "${YELLOW}warn${NC} $1"; }

CLAUDE_CFG="$HOME/.claude/settings.json"
OPENCODE_CFG="$HOME/.config/opencode/opencode.json"

CLAUDE_HOOK="$DIR/guard.sh"
OPENCODE_PLUGIN="$DIR/opencode-plugin.js"

# Build if needed
if [[ ! -f "$OPENCODE_PLUGIN" ]]; then
  info "Building opencode-plugin.js..."
  (cd "$DIR" && bun run guard:build)
fi

# ── Claude Code ─────────────────────────────────────────────────────────────

if [[ -f "$CLAUDE_CFG" ]]; then
  info "Updating Claude Code config..."

  # Remove old serena-guard hook if present (any path)
  tmp="$(mktemp)"
  jq 'del(.hooks.PreToolUse[]?.hooks[]? | select(.command | test("serena-guard/guard.sh")))' "$CLAUDE_CFG" > "$tmp" && mv "$tmp" "$CLAUDE_CFG"

  # Add new hook entry
  hook_entry="$(cat <<ENDJSON
{
  "matcher": "Read|Edit|Write|Grep|Bash",
  "hooks": [
    {
      "type": "command",
      "command": "$CLAUDE_HOOK",
      "timeout": 10,
      "statusMessage": "Serena Guard: redirecting to semantic tools..."
    }
  ]
}
ENDJSON
)"
  tmp="$(mktemp)"
  jq --argjson hook "$hook_entry" '.hooks.PreToolUse += [$hook]' "$CLAUDE_CFG" > "$tmp" && mv "$tmp" "$CLAUDE_CFG"
  ok "Claude Code hook registered: $CLAUDE_HOOK"
else
  warn "No Claude Code config at $CLAUDE_CFG — skipping"
fi

# ── OpenCode ────────────────────────────────────────────────────────────────

if [[ -f "$OPENCODE_CFG" ]]; then
  info "Updating OpenCode config..."

  # Remove old serena-guard plugin entries
  tmp="$(mktemp)"
  jq 'del(.plugin[]? | select(test("serena-guard")))' "$OPENCODE_CFG" > "$tmp" && mv "$tmp" "$OPENCODE_CFG"

  # Add new plugin entry
  tmp="$(mktemp)"
  jq --arg p "$OPENCODE_PLUGIN" '.plugin = ((.plugin // []) + [$p]) | unique' "$OPENCODE_CFG" > "$tmp" && mv "$tmp" "$OPENCODE_CFG"
  ok "OpenCode plugin registered: $OPENCODE_PLUGIN"
else
  warn "No OpenCode config at $OPENCODE_CFG — skipping"
fi

echo ""
info "Done. Restart Claude Code and OpenCode for changes to take effect."
echo ""
echo "  Quick test:  Read a .ts file — should be blocked."

#!/usr/bin/env bash
# install.sh — Install serena-guard for Claude Code and/or OpenCode.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}::${NC} $1"; }
ok()    { echo -e "${GREEN}ok${NC} $1"; }
warn()  { echo -e "${YELLOW}warn${NC} $1"; }
err()   { echo -e "${RED}error${NC} $1"; }

GIT_ROOT=""
if git rev-parse --show-toplevel &>/dev/null; then
  GIT_ROOT="$(git rev-parse --show-toplevel)"
else
  err "Cannot find project root (not a git repository)."
  info "Run this script from within your project directory."
  exit 1
fi

info "Project root: $GIT_ROOT"

# -- Resolve plugin source paths ----------------------------------------------

if [[ -f "$DIR/opencode-plugin.js" ]]; then
  OPENCODE_SRC="$DIR/opencode-plugin.js"
elif [[ -f "$DIR/opencode-plugin.ts" ]]; then
  info "Compiling opencode-plugin.ts..."
  bun build "$DIR/opencode-plugin.ts" --outfile "$DIR/opencode-plugin.js" --target=node --format=esm
  OPENCODE_SRC="$DIR/opencode-plugin.js"
fi

CLAUDE_SRC="$DIR/guard.sh"

if [[ ! -f "$CLAUDE_SRC" ]]; then
  err "Cannot find serena-guard hook files in $DIR."
  exit 1
fi

# -- Claude Code install ------------------------------------------------------

install_claude() {
  local target="$1"
  local label="$2"
  mkdir -p "$(dirname "$target")"

  local existing="{}"
  [[ -f "$target" ]] && existing="$(cat "$target")"

  if echo "$existing" | jq -e '.hooks.PreToolUse // empty' &>/dev/null; then
    warn "Claude Code hook already exists in $label — check $target manually."
  else
    local hook_entry
    hook_entry="$(cat <<ENDJSON
{
  "matcher": "Read|Edit|Write|Grep|Bash",
  "hooks": [
    {
      "type": "command",
      "command": "$CLAUDE_SRC",
      "timeout": 10,
      "statusMessage": "Serena Guard: redirecting to semantic tools..."
    }
  ]
}
ENDJSON
)"
    local merged
    merged="$(echo "$existing" | jq --argjson hook "$hook_entry" '.hooks.PreToolUse += [$hook]' 2>/dev/null)" || merged="$existing"
    echo "$merged" > "$target"
    ok "Claude Code hook added to $label ($target)"
  fi
}

info "Claude Code — project-local or global?"
read -rp "Install hook project-local (.claude/settings.local.json)? [Y/n] " ans
if [[ ! "$ans" =~ ^[Nn] ]]; then
  install_claude "$GIT_ROOT/.claude/settings.local.json" "project-local"
else
  info "Install hook globally (~/.claude/settings.json)?"
  read -rp "Add to global settings? [y/N] " ans2
  if [[ "$ans2" =~ ^[Yy] ]]; then
    install_claude "$HOME/.claude/settings.json" "global"
  fi
fi

# -- OpenCode install ---------------------------------------------------------

info "OpenCode — global or per-project?"
read -rp "Symlink plugin to ~/.config/opencode/plugins/? [Y/n] " ans
if [[ ! "$ans" =~ ^[Nn] ]]; then
  mkdir -p "$HOME/.config/opencode/plugins"
  if [[ -n "${OPENCODE_SRC:-}" ]]; then
    ln -sf "$OPENCODE_SRC" "$HOME/.config/opencode/plugins/serena-guard.js"
    ok "Symlinked → ~/.config/opencode/plugins/serena-guard.js"
  fi
else
  info "Add plugin entry to opencode.json?"
  read -rp "Add to $GIT_ROOT/opencode.json? [Y/n] " ans2
  if [[ ! "$ans2" =~ ^[Nn] ]]; then
    local opencode_cfg="$GIT_ROOT/opencode.json"
    if [[ ! -f "$opencode_cfg" ]]; then
      echo '{"$schema":"https://opencode.ai/config.json"}' > "$opencode_cfg"
    fi
    local plugin_path
    if [[ -f "$DIR/opencode-plugin.js" ]]; then
      plugin_path="$(realpath --relative-to="$GIT_ROOT" "$DIR/opencode-plugin.js")"
    elif [[ -f "$DIR/opencode-plugin.ts" ]]; then
      plugin_path="$(realpath --relative-to="$GIT_ROOT" "$DIR/opencode-plugin.ts")"
    else
      plugin_path="./serena-guard/opencode-plugin.js"
    fi
    local tmp; tmp="$(mktemp)"
    jq --arg p "$plugin_path" '.plugin = (.plugin // []) + [$p] | unique' "$opencode_cfg" > "$tmp" && mv "$tmp" "$opencode_cfg"
    ok "Added plugin entry to $opencode_cfg"
  fi
fi

echo ""
info "Summary"
echo "  Files:    $DIR/"
echo "  Claude:   $CLAUDE_SRC"
[[ -n "${OPENCODE_SRC:-}" ]] && echo "  OpenCode: $OPENCODE_SRC"
echo ""
info "Restart Claude Code / OpenCode for changes to take effect."
echo ""
echo "  Quick test:  Read a .ts file — should be blocked."

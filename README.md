# serena-guard

A Claude Code `PreToolUse` hook that hard-blocks direct file operations on code files
and redirects Claude to the correct Serena MCP or LSP tool, with the exact
replacement call pre-filled (path, line range, pattern already substituted).

## Why

Claude defaults to `Read`/`Edit`/`Write`/`Grep`/`Bash grep` on source files even
when Serena and LSP plugins are available. These tools are strictly inferior:

| Blocked call | Correct replacement | Why it's better |
|---|---|---|
| `Read(file.ts, offset, limit)` | `read_file` / `find_symbol` | Symbol-aware, no whole-file reads |
| `Edit(file.ts)` | `replace_symbol_body` / `replace_content` | Semantic, survives reformats |
| `Grep(pattern, src/)` | `search_for_pattern` / `find_symbol` | Returns structured symbol context |
| `Bash grep file.ts` | `search_for_pattern` | Same |
| `Bash find -name "*.ts"` | `find_file` | Same |

The hook fires before the tool executes, returns `{"continue": false, "stopReason": "..."}`,
and injects a stop message naming the exact replacement call with path and line range already
filled in from the blocked attempt. For example, if Claude tries:

```
Read(file_path="src/auth/token.ts", offset=120, limit=40)
```

it receives:

```
⛔ FORBIDDEN — Read on code files. SERENA: full support.  [.ts]
Target: /project/src/auth/token.ts

USE THIS:
  mcp__plugin_serena_serena__read_file(
    relative_path="src/auth/token.ts", start_line=120, end_line=159
  )
  — OR for a named symbol —
  mcp__plugin_serena_serena__find_symbol(name_path="SymbolName", include_body=True)

LSP (typescript-lsp@claude-plugins-official): hover · incomingCalls · outgoingCalls

Setup if not done: mcp__plugin_serena_serena__initial_instructions → activate_project
```

## Comparison with `serena-hook remind`

Serena ships a soft-nudge hook (`serena-hook remind`) that counts consecutive
grep/read calls and denies after a configurable threshold, then immediately resets
so the agent can continue. That hook is great for gently steering agents that
occasionally fall back to primitive tools.

serena-guard takes the opposite stance: **every** direct code-file access is
blocked, immediately and without exception. The stop message is directive — it
names the exact Serena or LSP tool to call, with the parameters already filled
in from the intercepted attempt.

| | `serena-hook remind` | serena-guard |
|---|---|---|
| Block strength | Soft (nudge after N calls, then allow) | Hard (every call, no exceptions) |
| Stop message | Generic reminder | Exact replacement call pre-filled |
| Extension list | Hardcoded `frozenset` in source | `extensions.yaml` — edit without touching code |
| LSP awareness | No | Per-extension LSP plugin name in stop message |
| Bash parsing | Shell-command classification | `shlex` parse: grep/find/rg targeting code files |

## Files

```
guard.sh        Bash wrapper — reads stdin JSON, exports env vars, calls check.py
check.py        Python enforcement logic (blocking decision + directed stop message)
extensions.yaml Extension → Serena support + LSP plugin metadata
README.md       This file
```

## Installation

```bash
git clone https://github.com/Lenucksi/serena-guard
```

Register in `~/.claude/settings.json` (user-global — applies across all projects):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Edit|Write|Grep|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/serena-guard/guard.sh",
            "timeout": 10,
            "statusMessage": "Enforcing Serena/LSP requirement..."
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/serena-guard` with the directory where you cloned this repo.
`guard.sh` derives the paths to `check.py` and `extensions.yaml` from its own
`$DIR`, so the absolute clone path is the only thing you need to change.

## What gets blocked

**Always blocked:**
- `Read`, `Edit`, `Write` on any extension listed in `extensions.yaml`
- `Grep` tool (always — use `search_for_pattern`)

**Blocked in the first pipeline segment only** (everything after `|` reads stdin,
never files — pipeline-filtering grep is never blocked):
- `Bash` with `rg` or `ag` (code-search tools by design)
- `Bash` with `grep -r` / `grep --recursive`
- `Bash` with `grep PATTERN file.ts` — code extension in file argument position
  (parsed via `shlex.split`; the pattern position is excluded, so
  `grep "\.ts" logfile.txt` is correctly not blocked)
- `Bash` with `find . -name "*.ts"` — code extension in `-name`/`-iname` value

**Never blocked:**
- `cmd 2>&1 | grep pattern` — output filtering
- `grep pattern logfile.txt` — non-code file extension in file argument
- `find . -newer package.json` — no `-name` with code extension
- Files under `~/.claude/` and `/tmp/` (Claude's own config and temp files)

## Extending

To add a language, append an entry to `extensions.yaml`:

```yaml
  - ext: .zig
    serena: true      # false if Serena has no LSP support for this language
    lsp_plugin: null  # Claude plugin ID, or null if none available
```

Known Claude LSP plugin IDs (set `lsp_plugin` to surface them in stop messages):

| Plugin | Languages |
|---|---|
| `typescript-lsp@claude-plugins-official` | `.ts` `.tsx` `.d.ts` `.js` `.jsx` `.mjs` `.cjs` `.vue` `.svelte` |
| `pyright-lsp@claude-plugins-official` | `.py` `.pyi` |
| `gopls-lsp@claude-plugins-official` | `.go` |
| `rust-analyzer-lsp@claude-plugins-official` | `.rs` |

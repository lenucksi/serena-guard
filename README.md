# serena-guard

A `PreToolUse` hook (Claude Code) and `tool.execute.before` plugin (OpenCode) that
hard-blocks direct file operations on code files and redirects the agent to the
correct Serena MCP or LSP tool, with the exact replacement call pre-filled (path,
line range, pattern already substituted from the blocked attempt).

## Why

Agents default to `Read`/`Edit`/`Write`/`Grep`/`Bash grep` on source files even
when Serena and LSP plugins are available. Direct file access is strictly inferior:

| Blocked call | Correct replacement | Why it's better |
|---|---|---|
| `Read(file.ts, offset, limit)` | `read_file` / `find_symbol` | Symbol-aware, no whole-file reads |
| `Edit(file.ts)` | `replace_symbol_body` / `replace_content` | Semantic, survives reformats |
| `Grep(pattern, src/)` | `search_for_pattern` / `find_symbol` | Returns structured symbol context |
| `Bash grep file.ts` | `search_for_pattern` | Same |
| `Bash find -name "*.ts"` | `find_file` | Same |

The hook fires before the tool executes and hard-blocks it, injecting a stop
message naming the exact replacement call with path and line range already filled
in from the intercepted attempt. For example, if the agent tries:

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
  /  serena_read_file(
    relative_path="src/auth/token.ts", start_line=120, end_line=159
  )
  — OR for a named symbol —
  mcp__plugin_serena_serena__find_symbol(name_path="SymbolName", include_body=True)
  /  serena_find_symbol(name_path="SymbolName", include_body=True)

LSP (typescript-lsp@claude-plugins-official): hover · incomingCalls · outgoingCalls

Setup if not done: mcp__plugin_serena_serena__initial_instructions
→ mcp__plugin_serena_serena__activate_project
  /  serena_initial_instructions → serena_activate_project
```

The stop message always shows both Claude Code (`mcp__plugin_serena_serena__*`)
and OpenCode (`serena_*`) tool names so the same hook works for both.

## Comparison with `serena-hook remind`

Serena ships a soft-nudge hook (`serena-hook remind`) that counts consecutive
grep/read calls and denies after a configurable threshold, then immediately resets
so the agent can continue.

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
| Bash parsing | Shell-command classification | `shell-quote` parse: grep/find/rg targeting code files |

## Files

```
guard-core.ts        Shared core: config discovery, extension matching, bash analysis, suggestions
guard-core.test.ts   Tests via `bun test`
claude-hook.ts       Claude Code entry — reads env vars, calls guard-core, prints JSON deny
opencode-plugin.ts   OpenCode entry — exports `tool.execute.before` handler, calls guard-core
guard.sh             Bash wrapper — reads stdin JSON, calls claude-hook.ts via bun/npx/node
extensions.yaml      Extension → Serena support + LSP plugin metadata
install.sh           Interactive install script
dev.sh               Build + test automation
.claude-plugin/plugin.json   Claude Code Marketplace metadata
hooks/hooks.json     Claude Code hook definition (uses ${CLAUDE_PLUGIN_ROOT})
```

All three targets (Claude Code hook, OpenCode plugin) share `guard-core.ts`.

## Installation

### Claude Code — Quick (marketplace)

From within the repo, run in Claude Code:

```
/plugin marketplace add .
/plugin install serena-guard@serena-guard-marketplace
```

The marketplace setup uses `hooks/hooks.json` and `.claude-plugin/plugin.json`.

### Claude Code — Manual

Register in `~/.claude/settings.json` (user-global) or `.claude/settings.local.json` (project-local):

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
            "statusMessage": "Serena Guard: redirecting to semantic tools..."
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/serena-guard` with the directory where you cloned this repo.
`guard.sh` derives everything from its own `$DIR`, so the absolute clone path is
the only thing you need to change.

### OpenCode — Global

Compile the plugin (requires Bun):

```bash
bun build opencode-plugin.ts --outfile opencode-plugin.js --target=node --format=esm
```

Then symlink into OpenCode's plugin directory:

```bash
ln -s /absolute/path/to/serena-guard/opencode-plugin.js \
      ~/.config/opencode/plugins/serena-guard.js
```

OpenCode auto-loads all `.js` files from `~/.config/opencode/plugins/`.

### OpenCode — Per Project

Add to `opencode.json`:

```json
{
  "plugin": ["./path/to/serena-guard/opencode-plugin.js"]
}
```

### Automated Install

Run the interactive install script from the target project:

```bash
./serena-guard/install.sh
```

It handles Claude Code (project-local or global) and OpenCode (global or per-project)
configuration, and builds the plugin if needed.

## What gets blocked

**Always blocked:**
- `Read`, `Edit`, `Write` on any extension listed in `extensions.yaml`
- `Grep` tool (always — use `search_for_pattern`)

**Blocked in the first pipeline segment only** (everything after `|` reads stdin,
never files — pipeline-filtering grep is never blocked):
- `Bash` with `rg` or `ag` (code-search tools by design)
- `Bash` with `grep -r` / `grep --recursive`
- `Bash` with `grep PATTERN file.ts` — code extension in file argument position
  (parsed via `shell-quote`; the pattern position is excluded, so
  `grep "\.ts" logfile.txt` is correctly not blocked)
- `Bash` with `find . -name "*.ts"` — code extension in `-name`/`-iname` value

**Never blocked:**
- `cmd 2>&1 | grep pattern` — output filtering
- `grep pattern logfile.txt` — non-code file extension in file argument
- `find . -newer package.json` — no `-name` with code extension
- Files under `/tmp/` and `node_modules/` (temp and dependency files)

## Configuration

The extension list is in `extensions.yaml`. To add a language, append:

```yaml
  - ext: .zig
    serena: true      # false if Serena has no LSP support for this language
    lsp_plugin: null  # Claude plugin ID, or null if none available
```

To point to a custom config file, set `SERENA_GUARD_CONFIG` environment variable
to the path of your YAML file. Default: `extensions.yaml` next to `guard-core.ts`.

## Development

```bash
# Run tests + build (one command)
./dev.sh

# Or individual steps
./dev.sh test    # bun test guard-core.test.ts
./dev.sh build   # compile TS to JS bundles
./dev.sh check   # Biome + TypeScript check

# Via npm scripts
bun run guard:test     # Tests
bun run guard:build    # Build OpenCode plugin
bun run guard:dev      # Test + build
```

## How it works per tool

### Claude Code

`guard.sh` is called as a `PreToolUse` hook. It reads the JSON payload from stdin,
extracts tool context into env vars, then runs `claude-hook.ts` (via `bun run`,
`npx tsx`, or `node`). If blocked, `claude-hook.ts` prints a JSON deny response
to stdout.

### OpenCode

`opencode-plugin.ts` exports a `tool.execute.before` handler (compiled to
`opencode-plugin.js`). OpenCode calls it before each tool execution. If the call
targets a code file, the handler throws an `Error` — OpenCode treats a thrown
error as a hard block and shows the error message to the model.

Both use the same shared core (`guard-core.ts`) and the same `extensions.yaml`.

## Extensions

Currently supported languages in `extensions.yaml`:

| Language | Extensions | LSP Plugin | Serena |
|---|---|---|---|
| TypeScript / JavaScript | `.ts` `.tsx` `.d.ts` `.js` `.jsx` `.mjs` `.cjs` | `typescript-lsp@claude-plugins-official` | ✅ |
| Python | `.py` `.pyi` | `pyright-lsp@claude-plugins-official` | ✅ |
| Go | `.go` | `gopls-lsp@claude-plugins-official` | ✅ |
| Rust | `.rs` | `rust-analyzer-lsp@claude-plugins-official` | ✅ |
| Vue / Svelte | `.vue` `.svelte` | `typescript-lsp@claude-plugins-official` | ✅ |
| Java | `.java` | `jdtls-lsp@claude-plugins-official` | ✅ |
| Kotlin | `.kt` `.kts` | `kotlin-lsp@claude-plugins-official` | ✅ |
| C / C++ / ObjC | `.c` `.cpp` `.h` `.m` `.mm` + more | `clangd-lsp@claude-plugins-official` | ✅ |
| C# | `.cs` `.csx` | `csharp-lsp@claude-plugins-official` | ✅ |
| Ruby | `.rb` `.rake` `.gemspec` `.ru` `.erb` | `ruby-lsp@claude-plugins-official` | ✅ |
| PHP | `.php` `.phtml` | `php-lsp@claude-plugins-official` | ✅ |
| Swift | `.swift` | `swift-lsp@claude-plugins-official` | ✅ |
| Lua | `.lua` | `lua-lsp@claude-plugins-official` | ✅ |
| Bash / Shell | `.sh` `.bash` `.zsh` `.ksh` | `bash-language-server@claude-code-lsps` | ✅ |
| Dart | `.dart` | `dart-analyzer@claude-code-lsps` | ✅ |
| Elixir | `.ex` `.exs` | `elixir-ls@claude-code-lsps` | ✅ |
| + 12 more | `.scala` `.gleam` `.clj` `.nix` `.ml` `.tf` `.zig` … | community plugins | ✅ |

## Comparison: Claude Code vs OpenCode

| | Claude Code | OpenCode |
|---|---|---|
| Hook mechanism | Shell command in `settings.json` `hooks.PreToolUse` | JS plugin `tool.execute.before` |
| Block method | JSON `{"permissionDecision": "deny"}` to stdout | `throw new Error(...)` |
| Config file | `extensions.yaml` (shared) | `extensions.yaml` (shared) |
| Global install | Entry in `~/.claude/settings.json` | Symlink to `~/.config/opencode/plugins/` |
| Per-project install | Entry in `.claude/settings.json` | `"plugin"` array in `opencode.json` |
| Shared logic | `guard-core.ts` | `guard-core.ts` (compiled to JS) |
| Runtime | Bun / npx / Node.js | OpenCode (Node.js) |

## License

MIT

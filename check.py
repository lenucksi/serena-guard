"""
Hook enforcement: block Read/Edit/Write/Grep/Bash on code files.
Reads context from env vars set by enforce_serena.sh.
"""
import json
import os
import re
import shlex
import subprocess
import sys

import yaml

CONFIG = os.environ["SERENA_EXT_CONFIG"]
tool = os.environ["HOOK_TOOL"]
fp = os.environ["HOOK_FP"]
cmd = os.environ["HOOK_CMD"]
try:
    tool_input = json.loads(os.environ.get("HOOK_INPUT", "{}"))
except json.JSONDecodeError:
    tool_input = {}

with open(CONFIG) as f:
    config = yaml.safe_load(f)

ext_map: dict = {e["ext"]: e for e in config["extensions"]}
sorted_exts = sorted(ext_map.keys(), key=len, reverse=True)

EXCLUDED_PREFIXES = (
    os.path.expanduser("~/.claude/"),
    "/tmp/",
)

CODE_EXT_PAT = re.compile(
    "(" + "|".join(re.escape(e) for e in sorted_exts) + r")\b"
)

OPTS_WITH_VALUE = {
    "-e", "-f", "-m", "-A", "-B", "-C", "-d", "--label",
    "--include", "--exclude", "--include-from", "--exclude-from",
    "--exclude-dir", "--color", "--binary-files", "--directories",
}


def get_entry(path: str):
    lower = path.lower()
    for ext in sorted_exts:
        if lower.endswith(ext):
            return ext, ext_map[ext]
    return None, None


def relative_path(abs_path: str) -> str:
    """Best-effort relative path from git/project root."""
    try:
        root = subprocess.check_output(
            ["git", "-C", os.path.dirname(abs_path), "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return os.path.relpath(abs_path, root)
    except Exception:
        return abs_path


def bash_targets_code(seg: str) -> bool:
    if re.search(r"\b(rg|ag)\b", seg):
        return True
    try:
        tokens = shlex.split(seg)
    except ValueError:
        tokens = seg.split()
    if not tokens:
        return False
    cmd_name = re.sub(r"^[&;\s]+", "", tokens[0])
    if cmd_name in ("grep", "egrep", "fgrep"):
        if re.search(r"\s-[a-zA-Z]*[rR]\b|--recursive\b", seg):
            return True
        positional, i = [], 1
        while i < len(tokens):
            t = tokens[i]
            if t.startswith("-"):
                if "=" in t:
                    if CODE_EXT_PAT.search(t.split("=", 1)[1]):
                        return True
                elif t in OPTS_WITH_VALUE:
                    i += 2
                    continue
            else:
                positional.append(t)
            i += 1
        return any(CODE_EXT_PAT.search(f) for f in positional[1:])
    if cmd_name == "find":
        for i, t in enumerate(tokens[1:], 1):
            if t in ("-name", "-iname") and i < len(tokens):
                if CODE_EXT_PAT.search(tokens[i]):
                    return True
        return False
    return False


# ── Determine whether to block ───────────────────────────────────────────────

block = False
matched_ext: str | None = None
entry: dict | None = None

if tool in ("Read", "Edit", "Write"):
    if any(fp.startswith(p) for p in EXCLUDED_PREFIXES):
        sys.exit(0)
    matched_ext, entry = get_entry(fp)
    if entry:
        block = True
elif tool == "Grep":
    block = True
elif tool == "Bash":
    first_seg = cmd.split("|")[0]
    block = bash_targets_code(first_seg)

if not block:
    sys.exit(0)

# ── Build a directed, concrete stop message ──────────────────────────────────

lsp_plugin = (entry or {}).get("lsp_plugin") or None
lsp_line = f"LSP ({lsp_plugin}): hover · incomingCalls · outgoingCalls" if lsp_plugin else ""
serena_ok = (entry or {}).get("serena", False)

setup = (
    "Setup if not done: mcp__plugin_serena_serena__initial_instructions"
    " → activate_project"
)

if tool == "Read":
    rel = relative_path(fp)
    offset = tool_input.get("offset", 0) or 0
    limit = tool_input.get("limit")
    if limit:
        end = offset + limit - 1
        range_args = f"start_line={offset}, end_line={end}"
    else:
        range_args = f"start_line={offset}"
    specific = (
        f"USE THIS:\n"
        f"  mcp__plugin_serena_serena__read_file(\n"
        f'    relative_path="{rel}", {range_args}\n'
        f"  )\n"
        f"  — OR for a named symbol —\n"
        f"  mcp__plugin_serena_serena__find_symbol(name_path=\"SymbolName\", include_body=True)"
    )

elif tool == "Edit":
    rel = relative_path(fp)
    specific = (
        f"USE ONE OF THESE:\n"
        f"  mcp__plugin_serena_serena__replace_symbol_body(...)   ← whole symbol replacement\n"
        f"  mcp__plugin_serena_serena__replace_content(           ← regex patch within symbol\n"
        f'    relative_path="{rel}", ...)\n'
        f"  mcp__plugin_serena_serena__insert_after_symbol(...)   ← new code after a symbol"
    )

elif tool == "Write":
    rel = relative_path(fp)
    specific = (
        f"USE ONE OF THESE:\n"
        f"  mcp__plugin_serena_serena__replace_symbol_body(...)   ← overwrite existing symbol\n"
        f"  mcp__plugin_serena_serena__insert_after_symbol(       ← insert new symbol\n"
        f'    relative_path="{rel}", ...)\n'
        f"  mcp__plugin_serena_serena__insert_before_symbol(...)"
    )

elif tool == "Grep":
    pattern = tool_input.get("pattern", "")
    path_arg = tool_input.get("path", "")
    rel_path_arg = relative_path(path_arg) if path_arg and os.path.isabs(path_arg) else path_arg
    specific = (
        f"USE THIS:\n"
        f"  mcp__plugin_serena_serena__search_for_pattern(\n"
        f'    pattern="{pattern}",\n'
        f'    relative_path="{rel_path_arg}",  # or omit for whole project\n'
        f"  )\n"
        f"  — OR for symbol lookup —\n"
        f"  mcp__plugin_serena_serena__find_symbol(name_path=\"SymbolName\")"
    )

else:  # Bash
    specific = (
        f"USE THIS:\n"
        f"  mcp__plugin_serena_serena__search_for_pattern(pattern=\"...\", relative_path=\"...\")\n"
        f"  mcp__plugin_serena_serena__find_symbol(name_path=\"...\")\n"
        f"  mcp__plugin_serena_serena__find_file(pattern=\"...\")"
    )

serena_status = "SERENA: full support" if (serena_ok or tool == "Grep") else "SERENA: limited/no support"
header = f"⛔ FORBIDDEN — {tool} on code files. {serena_status}."
if matched_ext:
    header += f"  [{matched_ext}]"

short_reason = f"{header}\nTarget: {fp or cmd}"
context_lines = ["", specific]
if lsp_line:
    context_lines += ["", lsp_line]
context_lines += ["", setup]
context = "\n".join(context_lines).strip()

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": short_reason,
        "additionalContext": context,
    }
}))

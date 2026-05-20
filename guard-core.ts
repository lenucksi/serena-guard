import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseShell } from "shell-quote"
import { parse as parseYaml } from "yaml"

export interface ExtEntry {
	ext: string
	serena: boolean
	lsp_plugin: string | null
}

export interface GuardConfig {
	extMap: Map<string, ExtEntry>
	sortedExts: string[]
	configPath: string
}

export interface GuardInput {
	tool: string
	filePath?: string
	command?: string
	grepPath?: string
	grepPattern?: string
}

export interface GuardResult {
	blocked: boolean
	blockedPath?: string
	matchedExt?: string
	entry?: ExtEntry
	errorMessage?: string
}

const DEFAULT_CONFIG_PATH = process.env.SERENA_GUARD_CONFIG || ""

const EXCLUDED_PREFIXES = ["/tmp/", "/node_modules/"]

const OPTS_WITH_VALUE = new Set([
	"-e",
	"-f",
	"-m",
	"-A",
	"-B",
	"-C",
	"-d",
	"--label",
	"--include",
	"--exclude",
	"--include-from",
	"--exclude-from",
	"--exclude-dir",
	"--color",
	"--binary-files",
	"--directories",
])

let _configCache: GuardConfig | null | undefined

function getHookDir(): string {
	if (typeof __dirname !== "undefined") return __dirname
	if (typeof process !== "undefined" && process.env.HOOK_DIR) return process.env.HOOK_DIR
	const url = import.meta.url
	if (url) return dirname(fileURLToPath(url))
	return process.cwd()
}

export function resolveConfigPath(hookDir?: string): string {
	if (DEFAULT_CONFIG_PATH) return DEFAULT_CONFIG_PATH
	const dir = hookDir || getHookDir()
	const candidate = join(dir, "extensions.yaml")
	if (existsSync(candidate)) return candidate
	return ""
}

export function loadConfig(configPath?: string): GuardConfig | null {
	if (_configCache !== undefined) return _configCache

	const path = configPath ?? resolveConfigPath()
	if (!path || !existsSync(path)) {
		_configCache = null
		return null
	}

	const raw = readFileSync(path, "utf8")
	const data = parseYaml(raw) as { extensions?: ExtEntry[] } | null
	if (!data?.extensions) {
		_configCache = null
		return null
	}

	const extMap = new Map<string, ExtEntry>()
	for (const e of data.extensions) {
		extMap.set(e.ext.toLowerCase(), e)
	}
	const sortedExts = [...extMap.keys()].sort((a, b) => b.length - a.length)

	_configCache = { extMap, sortedExts, configPath: path }
	return _configCache
}

export function clearConfigCache(): void {
	_configCache = undefined
}

export function getEntry(path: string): { ext: string; entry: ExtEntry } | null {
	const cfg = loadConfig()
	if (!cfg) return null
	const lower = path.toLowerCase()
	for (const ext of cfg.sortedExts) {
		if (lower.endsWith(ext)) {
			const entry = cfg.extMap.get(ext)
			if (entry) return { ext, entry }
		}
	}
	return null
}

export function isCodeFile(filePath: string): boolean {
	if (!filePath) return false
	const lower = filePath.toLowerCase()
	for (const prefix of EXCLUDED_PREFIXES) {
		if (lower.includes(prefix)) return false
	}
	return getEntry(filePath) !== null
}

function buildCodeExtPattern(sortedExts: string[]): RegExp {
	const escaped = sortedExts.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	return new RegExp(`(${escaped.join("|")})\\b`)
}

interface ShellToken {
	comment?: string
	op?: string
	pattern?: string
	glob?: string
}

export function bashTargetsCode(segment: string): boolean {
	const cleaned = segment.replace(/\\\n/g, " ")
	if (/\b(rg|ag)\b/.test(cleaned)) return true

	const tokens = (parseShell(cleaned) as (string | ShellToken)[]).filter(Boolean)
	if (tokens.length === 0) return false

	const first = tokens[0]
	if (typeof first !== "string") return false
	const cmdName = basename(first.replace(/^[&;\s]+/, ""))

	const cfg = loadConfig()
	if (!cfg) return false
	const extPat = buildCodeExtPattern(cfg.sortedExts)

	if (cmdName === "grep" || cmdName === "egrep" || cmdName === "fgrep") {
		if (/\s-[a-zA-Z]*[rR]\b|--recursive\b/.test(cleaned)) return true
		const positional: string[] = []
		let i = 1
		while (i < tokens.length) {
			const t = tokens[i]
			if (typeof t !== "string") {
				i++
				continue
			}
			if (t.startsWith("-")) {
				if (t.includes("=")) {
					if (extPat.test(t.split("=", 2)[1])) return true
				} else if (OPTS_WITH_VALUE.has(t)) {
					i += 2
					continue
				}
			} else {
				positional.push(t)
			}
			i++
		}
		return positional.slice(1).some((f) => extPat.test(f))
	}

	if (cmdName === "find") {
		for (let i = 1; i < tokens.length; i++) {
			const t = tokens[i]
			if (typeof t !== "string") continue
			if (t === "-name" || t === "-iname") {
				if (i + 1 < tokens.length && typeof tokens[i + 1] === "string") {
					if (extPat.test(tokens[i + 1] as string)) return true
				}
			}
		}
		return false
	}

	return false
}

export function toRelative(absPath: string): string {
	try {
		const root = execSync("git rev-parse --show-toplevel", {
			cwd: dirname(absPath),
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim()
		return resolve(absPath).replace(`${resolve(root)}/`, "")
	} catch {
		return absPath
	}
}

function serena(tool: string): string {
	return `serena_${tool}`
}

function serenaCC(tool: string): string {
	return `mcp__plugin_serena_serena__${tool}`
}

function both(tool: string): string {
	return `${serenaCC(tool)}  /  ${serena(tool)}`
}

function buildErrorMessage(
	tool: string,
	blockedPath: string,
	matchedExt: string | null,
	entry: ExtEntry | null,
	toolInput: Record<string, unknown>,
	cmd: string,
): string {
	const lspPlugin = entry?.lsp_plugin || null
	const serenaOk = entry?.serena ?? tool === "Grep"
	const serenaStatus = serenaOk ? "SERENA: full support" : "SERENA: limited/no support"

	let header = `⛔ FORBIDDEN — ${tool} on code files. ${serenaStatus}.`
	if (matchedExt) header += `  [${matchedExt}]`

	const target = blockedPath || cmd
	let specific = ""

	if (tool === "Read") {
		const rel = toRelative(blockedPath)
		const offset = (toolInput.offset as number) || 0
		const limit = toolInput.limit as number | undefined
		const rangeArgs = limit
			? `start_line=${offset}, end_line=${offset + limit - 1}`
			: `start_line=${offset}`
		specific = [
			"USE THIS:",
			`  ${both("read_file")}(`,
			`    relative_path="${rel}", ${rangeArgs}`,
			"  )",
			`  — OR for a named symbol —`,
			`  ${both("find_symbol")}(name_path="SymbolName", include_body=True)`,
		].join("\n")
	} else if (tool === "Edit") {
		const rel = toRelative(blockedPath)
		specific = [
			"USE ONE OF THESE:",
			`  ${both("replace_symbol_body")}(...)   ← whole symbol replacement`,
			`  ${both("replace_content")}(           ← regex patch within symbol`,
			`    relative_path="${rel}", ...)`,
			`  ${both("insert_after_symbol")}(...)   ← new code after a symbol`,
		].join("\n")
	} else if (tool === "Write") {
		const rel = toRelative(blockedPath)
		specific = [
			"USE ONE OF THESE:",
			`  ${both("replace_symbol_body")}(...)   ← overwrite existing symbol`,
			`  ${both("insert_after_symbol")}(       ← insert new symbol`,
			`    relative_path="${rel}", ...)`,
			`  ${both("insert_before_symbol")}(...)`,
		].join("\n")
	} else if (tool === "Grep") {
		const pattern = (toolInput.pattern as string) || "..."
		const pathArg = (toolInput.path as string) || ""
		const relPathArg = pathArg && resolve(pathArg) !== pathArg ? pathArg : toRelative(pathArg)
		specific = [
			"USE THIS:",
			`  ${both("search_for_pattern")}(`,
			`    pattern="${pattern}",`,
			`    relative_path="${relPathArg}",  # or omit for whole project`,
			"  )",
			`  — OR for symbol lookup —`,
			`  ${both("find_symbol")}(name_path="SymbolName")`,
		].join("\n")
	} else {
		specific = [
			"USE THIS:",
			`  ${both("search_for_pattern")}(pattern="...", relative_path="...")`,
			`  ${both("find_symbol")}(name_path="...")`,
			`  ${both("find_file")}(pattern="...")`,
		].join("\n")
	}

	const lines = [header, `Target: ${target}`, "", specific]

	if (lspPlugin) {
		lines.push("", `LSP (${lspPlugin}): hover · incomingCalls · outgoingCalls`)
	}

	lines.push("", `Setup if not done: ${both("initial_instructions")} → ${both("activate_project")}`)

	return lines.join("\n")
}

export function evaluate(input: GuardInput): GuardResult {
	const cfg = loadConfig()
	if (!cfg) return { blocked: false }

	const { tool, filePath, command } = input
	let block = false
	let matchedExt: string | null = null
	let entry: ExtEntry | null = null

	if (tool === "Read" || tool === "Edit" || tool === "Write") {
		const fp = filePath || ""
		if (EXCLUDED_PREFIXES.some((p) => fp.toLowerCase().includes(p))) {
			return { blocked: false }
		}
		const result = getEntry(fp)
		if (result) {
			block = true
			matchedExt = result.ext
			entry = result.entry
		}
	} else if (tool === "Grep") {
		block = true
	} else if (tool === "Bash") {
		const cmd = command || ""
		const firstSeg = cmd.split("|")[0] || ""
		block = bashTargetsCode(firstSeg)
	}

	if (!block) return { blocked: false }

	const result: GuardResult = {
		blocked: true,
		blockedPath: filePath || command || "",
		matchedExt: matchedExt || undefined,
		entry: entry || undefined,
	}

	result.errorMessage = buildErrorMessage(
		tool,
		result.blockedPath || "",
		matchedExt,
		entry,
		{},
		command || "",
	)

	return result
}

export function createGuardEntry(input: GuardInput): GuardResult {
	const cfg = loadConfig()
	if (!cfg) return { blocked: false }
	return evaluate(input)
}

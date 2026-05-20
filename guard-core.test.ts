import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	bashTargetsCode,
	clearConfigCache,
	evaluate,
	getEntry,
	isCodeFile,
	loadConfig,
} from "./guard-core"

let tmpDir: string

function createExtensionsYaml(exts: string[]): string {
	const lines = ["extensions:"]
	for (const ext of exts) {
		lines.push(`  - ext: ${ext}`)
		lines.push("    serena: true")
		lines.push("    lsp_plugin: null")
	}
	const p = join(tmpDir, "extensions.yaml")
	writeFileSync(p, lines.join("\n"))
	return p
}

beforeEach(() => {
	clearConfigCache()
	tmpDir = mkdtempSync(join(tmpdir(), "serena-guard-test-"))
})

// -- Config loading -----------------------------------------------------------

describe("loadConfig", () => {
	test("loads extensions.yaml with entries", () => {
		const cfgPath = createExtensionsYaml([".ts", ".py"])
		const cfg = loadConfig(cfgPath)
		expect(cfg).not.toBeNull()
		expect(cfg?.extMap.size).toBe(2)
		expect(cfg?.extMap.has(".ts")).toBe(true)
		expect(cfg?.extMap.has(".py")).toBe(true)
	})

	test("returns null for missing file", () => {
		const cfg = loadConfig(join(tmpDir, "nonexistent.yaml"))
		expect(cfg).toBeNull()
	})
})

// -- Extension matching -------------------------------------------------------

describe("getEntry", () => {
	test("matches .ts file", () => {
		createExtensionsYaml([".ts", ".js", ".py"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		const result = getEntry(join(tmpDir, "src", "main.ts"))
		expect(result).not.toBeNull()
		expect(result?.ext).toBe(".ts")
	})

	test("matches .tsx file", () => {
		createExtensionsYaml([".ts", ".tsx", ".py"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		const result = getEntry(join(tmpDir, "component.tsx"))
		expect(result).not.toBeNull()
		expect(result?.ext).toBe(".tsx")
	})

	test("returns null for .md file", () => {
		createExtensionsYaml([".ts", ".py"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		const result = getEntry(join(tmpDir, "readme.md"))
		expect(result).toBeNull()
	})

	test("longest extension wins", () => {
		createExtensionsYaml([".ts", ".d.ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		const result = getEntry(join(tmpDir, "types.d.ts"))
		expect(result).not.toBeNull()
		expect(result?.ext).toBe(".d.ts")
	})
})

describe("isCodeFile", () => {
	test("returns true for .ts inside project", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		expect(isCodeFile("/project/src/main.ts")).toBe(true)
	})

	test("returns false for excluded paths", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		expect(isCodeFile("/tmp/test.ts")).toBe(false)
		expect(isCodeFile("/project/node_modules/pkg/index.ts")).toBe(false)
	})
})

// -- Bash analysis ------------------------------------------------------------

describe("bashTargetsCode", () => {
	test("blocks rg", () => {
		createExtensionsYaml([".ts", ".py"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		expect(bashTargetsCode('rg "pattern" src/')).toBe(true)
	})

	test("blocks ag", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		expect(bashTargetsCode('ag "pattern" src/')).toBe(true)
	})

	test("blocks grep -r", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		expect(bashTargetsCode('grep -r "pattern" src/')).toBe(true)
	})

	test("blocks grep --recursive", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		expect(bashTargetsCode('grep --recursive "pattern" src/')).toBe(true)
	})

	test("blocks grep PATTERN file.ts", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		expect(bashTargetsCode('grep "pattern" main.ts')).toBe(true)
	})

	test("does not block pipeline grep", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		expect(bashTargetsCode("cmd | grep pattern")).toBe(false)
	})

	test("does not block grep on log file", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		expect(bashTargetsCode('grep "pattern" logfile.txt')).toBe(false)
	})

	test("blocks find with -name *.ts", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		expect(bashTargetsCode('find . -name "*.ts"')).toBe(true)
	})

	test("does not block find without code extension", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		expect(bashTargetsCode('find . -name "*.md"')).toBe(false)
	})
})

// -- evaluate() end-to-end ----------------------------------------------------

describe("evaluate", () => {
	test("Read on .ts file is blocked", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		const result = evaluate({ tool: "Read", filePath: "/project/src/main.ts" })
		expect(result.blocked).toBe(true)
		expect(result.errorMessage).toContain("serena_read_file")
		expect(result.errorMessage).toContain("mcp__plugin_serena_serena__read_file")
		expect(result.errorMessage).toContain("[.ts]")
	})

	test("Read on .md file is allowed", () => {
		createExtensionsYaml([".ts", ".py"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		const result = evaluate({ tool: "Read", filePath: "/project/readme.md" })
		expect(result.blocked).toBe(false)
	})

	test("Edit on .ts file suggests replace_symbol_body", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		const result = evaluate({ tool: "Edit", filePath: "/project/src/main.ts" })
		expect(result.blocked).toBe(true)
		expect(result.errorMessage).toContain("serena_replace_symbol_body")
		expect(result.errorMessage).toContain("serena_replace_content")
		expect(result.errorMessage).toContain("serena_insert_after_symbol")
	})

	test("Write on .py file suggests insert_after_symbol", () => {
		createExtensionsYaml([".py"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		const result = evaluate({ tool: "Write", filePath: "/project/src/module.py" })
		expect(result.blocked).toBe(true)
		expect(result.errorMessage).toContain("serena_replace_symbol_body")
		expect(result.errorMessage).toContain("serena_insert_after_symbol")
		expect(result.errorMessage).toContain("serena_insert_before_symbol")
	})

	test("Grep is always blocked", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		const result = evaluate({
			tool: "Grep",
			grepPath: "/project/src",
			grepPattern: "pattern",
		})
		expect(result.blocked).toBe(true)
		expect(result.errorMessage).toContain("serena_search_for_pattern")
		expect(result.errorMessage).toContain("serena_find_symbol")
	})

	test("Bash rg is blocked", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		const result = evaluate({ tool: "Bash", command: 'rg "pattern" src/' })
		expect(result.blocked).toBe(true)
	})

	test("Bash pipeline grep is not blocked", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		const result = evaluate({ tool: "Bash", command: "cmd | grep pattern" })
		expect(result.blocked).toBe(false)
	})

	test("Read on excluded path is allowed", () => {
		createExtensionsYaml([".ts"])
		loadConfig(join(tmpDir, "extensions.yaml"))
		const result = evaluate({ tool: "Read", filePath: "/tmp/test.ts" })
		expect(result.blocked).toBe(false)
	})

	test("empty config path returns null", () => {
		const cfg = loadConfig("/nonexistent/path/extensions.yaml")
		expect(cfg).toBeNull()
	})
})

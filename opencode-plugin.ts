import { evaluate, type GuardInput, loadConfig } from "./guard-core"

export const SerenaGuardPlugin = async () => {
	return {
		"tool.execute.before": async (
			input: { tool?: string },
			output: { args?: Record<string, unknown> },
		) => {
			const cfg = loadConfig()
			if (!cfg) return

			const tool = input.tool || ""
			const args = output.args || {}

			const guardInput: GuardInput = {
				tool,
				filePath: (args.filePath as string) || (args.path as string) || "",
				command: (args.command as string) || (args.cmd as string) || "",
				grepPath: (args.path as string) || "",
				grepPattern: (args.pattern as string) || "",
			}

			const result = evaluate(guardInput)
			if (!result.blocked) return

			throw new Error(result.errorMessage)
		},
		"experimental.chat.system.transform": async (
			_input: { sessionID?: string; model: string },
			output: { system: string[] },
		) => {
			output.system.push(
				"The serena-guard plugin blocks direct Read/Edit/Write/Grep/Bash on code files. " +
					"Use Serena MCP tools (serena_find_symbol, serena_read_file, serena_replace_symbol_body, " +
					"serena_search_for_pattern) or built-in LSP tools (lsp tool) for code navigation and editing. " +
					"Do NOT manually try to work around the guard — it enforces correct tool usage.",
			)
		},
	}
}

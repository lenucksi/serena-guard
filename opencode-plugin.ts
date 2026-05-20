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
	}
}

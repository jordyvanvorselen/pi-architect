import { checkReadOnly } from "./commands.ts";

/** Built-in tools that change files. Architect mode turns them off and blocks them if something turns them back on. */
export const WRITE_TOOLS = ["edit", "write"] as const;

const NOTE = "Architect mode is read-only. The user can switch to build mode with /mode build.";

/**
 * Why a tool call is not allowed in architect mode, or undefined when it is.
 * The reason goes back to the model as the tool result, so it says what to do instead.
 */
export function blockReason(toolName: string, input: unknown): string | undefined {
	if ((WRITE_TOOLS as readonly string[]).includes(toolName))
		return `${toolName} is off in architect mode. Describe the change in the design instead. ${NOTE}`;
	if (toolName === "powershell") return `powershell is off in architect mode. Use read, grep, find or ls. ${NOTE}`;
	if (toolName !== "bash") return undefined;
	const command = (input as { command?: unknown } | undefined)?.command;
	if (typeof command !== "string") return undefined;
	const check = checkReadOnly(command);
	if (check.ok) return undefined;
	return `Blocked: ${check.reason}. Only read-only commands run in architect mode; use read, grep, find or ls for files. ${NOTE}`;
}

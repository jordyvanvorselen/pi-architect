import { checkReadOnly } from "./commands.ts";

/** Built-in tools that change files. Architect mode turns them off and blocks them if something turns them back on. */
export const WRITE_TOOLS = ["edit", "write"] as const;

/** Pi's built-in tools that only read. `bash` is allowed too, but every command goes through the read-only check. */
export const READ_TOOLS = ["read", "grep", "find", "ls"] as const;

const NOTE = "This is architect mode, which is read-only. The user can switch to build mode with /architect build.";

/** Whether architect mode allows a tool: the read tools, bash (checked) and the architect tools. Anything else is off. */
export function allowedInArchitect(toolName: string): boolean {
	return (
		(READ_TOOLS as readonly string[]).includes(toolName) || toolName === "bash" || toolName.startsWith("architect_")
	);
}

/**
 * Why a tool call is not allowed in architect mode, or undefined when it is.
 * The reason goes back to the model as the tool result, so it says what to do instead.
 */
export function blockReason(toolName: string, input: unknown): string | undefined {
	if ((WRITE_TOOLS as readonly string[]).includes(toolName))
		return `${toolName} is off in architect mode. Describe the change in the design instead. ${NOTE}`;
	if (!allowedInArchitect(toolName))
		return `${toolName} is off in architect mode. Use read, grep, find, ls, read-only bash or the architect tools. ${NOTE}`;
	if (toolName !== "bash") return undefined;
	const command = (input as { command?: unknown } | undefined)?.command;
	if (typeof command !== "string") return `Blocked: bash needs a command. ${NOTE}`;
	const check = checkReadOnly(command);
	if (check.ok) return undefined;
	return `Blocked: ${check.reason}. Only read-only commands run in architect mode; use read, grep, find or ls for files. ${NOTE}`;
}

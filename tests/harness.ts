import ext, { type ArchitectOverrides } from "../src/index.ts";
import { FakeUi, plainTheme } from "./helpers.ts";
import { tempDir } from "./temp.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface RenderContext {
	lastComponent: unknown;
	isError: boolean;
}

export interface ToolDef {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	defaultActive?: boolean;
	executionMode?: string;
	prepareArguments?: (args: unknown) => unknown;
	execute: (
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<ToolResult>;
	renderCall?: (args: unknown, theme: unknown, context: RenderContext) => { render(width: number): string[] };
	renderResult?: (
		result: unknown,
		options: { expanded: boolean; isPartial: boolean },
		theme: unknown,
		context: RenderContext,
	) => { render(width: number): string[] };
}

export interface ToolResult {
	content: { type: string; text: string }[];
	details: Record<string, unknown> | undefined;
	isError?: boolean;
	terminate?: boolean;
}

export interface Command {
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
	getArgumentCompletions?: (prefix: string) => unknown;
}

export interface Sent {
	message: { customType: string; content: string; display: boolean; details?: unknown };
	options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

/** What a command passed to `ctx.newSession`. */
export interface NewSessionOptions {
	parentSession?: string;
	setup?: (sessionManager: { appendCustomEntry(customType: string, data: unknown): void }) => Promise<void>;
	withSession?: (ctx: { sendUserMessage(content: string): Promise<void> }) => Promise<void>;
}

export type BranchEntry = { type: string; customType?: string; data?: unknown; details?: unknown; content?: unknown };

/**
 * A stub `pi` and `ctx` that record what the extension does. Headless unless `ui` is given.
 * Entries the extension appends land on `branch`, like on Pi's current branch.
 */
export function harness(
	options: {
		overrides?: ArchitectOverrides;
		branch?: BranchEntry[];
		ui?: FakeUi;
		mode?: "tui" | "rpc" | "print";
		flags?: Record<string, boolean>;
		/** Tools Pi has besides the extension's own. */
		builtins?: string[];
		/**
		 * The tool set Pi starts with, like the one it keeps after a reload, or restores from the transcript
		 * after a resume or /tree. Default: the builtins plus the extension's tools that are active by default.
		 */
		activeTools?: string[];
		/**
		 * The session's cwd. Default: a fresh temp directory, so a written plan never lands in a real project.
		 * It is removed after the tests of the file.
		 */
		cwd?: string;
		/** Exit code of every `pi.exec` call. */
		execCode?: number;
		/** `ctx.newSession` reports a cancel. */
		cancelNewSession?: boolean;
	} = {},
) {
	const handlers: Record<string, Handler[]> = {};
	const tools: Record<string, ToolDef> = {};
	const commands: Record<string, Command> = {};
	const shortcuts: Record<string, (ctx: unknown) => unknown> = {};
	const flags: Record<string, unknown> = {};
	const entryRenderers: Record<string, (entry: unknown, options: unknown, theme: unknown) => unknown> = {};
	const sent: Sent[] = [];
	const userMessages: { content: unknown; options: unknown }[] = [];
	const execs: { command: string; args: string[] }[] = [];
	const newSessions: NewSessionOptions[] = [];
	const entries: { customType: string; data: Record<string, unknown> }[] = [];
	const branch: BranchEntry[] = options.branch ?? [];
	const builtins = options.builtins ?? ["read", "bash", "edit", "write", "grep", "find", "ls"];
	let active = [...builtins];
	const activeHistory: string[][] = [];
	let clock = 1_000;
	const cwd = options.cwd ?? tempDir();

	const pi = {
		on: (event: string, handler: Handler) => (handlers[event] ??= []).push(handler),
		registerTool: (tool: ToolDef) => {
			tools[tool.name] = tool;
			if (tool.defaultActive !== false) active.push(tool.name);
		},
		registerCommand: (name: string, opts: Command) => (commands[name] = opts),
		registerShortcut: (key: string, opts: { handler: (ctx: unknown) => unknown }) => (shortcuts[key] = opts.handler),
		registerFlag: (name: string, opts: unknown) => (flags[name] = opts),
		getFlag: (name: string) => options.flags?.[name],
		registerEntryRenderer: (type: string, renderer: (entry: unknown, options: unknown, theme: unknown) => unknown) =>
			(entryRenderers[type] = renderer),
		registerMessageRenderer: () => {},
		sendMessage: (message: Sent["message"], opts: Sent["options"]) => sent.push({ message, options: opts }),
		sendUserMessage: (content: unknown, opts: unknown) => userMessages.push({ content, options: opts }),
		exec: async (command: string, args: string[]) => {
			execs.push({ command, args });
			return { code: options.execCode ?? 0, stdout: "", stderr: "", killed: false };
		},
		appendEntry: (customType: string, data: Record<string, unknown>) => {
			entries.push({ customType, data });
			branch.push({ type: "custom", customType, data });
		},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			const known = new Set([...builtins, ...Object.keys(tools)]);
			active = names.filter((n) => known.has(n));
			activeHistory.push([...active]);
		},
		getAllTools: () => [...builtins.map((name) => ({ name })), ...Object.values(tools).map((t) => ({ name: t.name }))],
		getSessionName: () => undefined,
		events: { emit: () => {}, on: () => () => {} },
	};

	const ui = options.ui;
	const ctx = {
		cwd,
		mode: options.mode ?? (ui ? "tui" : "print"),
		hasUI: Boolean(ui),
		ui: ui ?? { theme: plainTheme, notify: () => {}, setStatus: () => {}, setWidget: () => {} },
		isIdle: () => true,
		newSession: async (opts: NewSessionOptions) => {
			newSessions.push(opts);
			return { cancelled: options.cancelNewSession ?? false };
		},
		signal: undefined,
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => "/sessions/test.jsonl",
			getBranch: () => branch,
			getCwd: () => cwd,
		},
	};

	// No input grace by default, so scripted keys land at once. Tests of the grace period pass their own.
	ext(pi as never, { now: () => ++clock, inputGrace: 0, ...options.overrides });
	if (options.activeTools) active = [...options.activeTools];

	const fire = async (event: string, payload: object = {}) => {
		let result: unknown;
		for (const handler of handlers[event] ?? []) result = (await handler({ type: event, ...payload }, ctx)) ?? result;
		return result as Record<string, unknown> | undefined;
	};

	/** Call a tool like Pi does: prepareArguments, then execute. Throws like execute. */
	const call = async (name: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
		const tool = tools[name];
		if (!tool) throw new Error(`no tool ${name}`);
		const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params;
		return tool.execute("call-1", prepared, signal, undefined, ctx);
	};

	const command = (name: string, args = "") => commands[name]!.handler(args, ctx);

	/** Run before_agent_start like Pi, and keep an injected message on the branch like Pi does. */
	const startRun = async (messageType: "user" | "custom" = "user") => {
		const systemPromptOptions = { sections: {} as Record<string, string> };
		const result = (await fire("before_agent_start", {
			messageType,
			prompt: "hi",
			systemPrompt: "",
			systemPromptOptions,
		})) as { message?: { customType: string; content: string; details?: unknown } } | undefined;
		if (result?.message)
			branch.push({
				type: "custom_message",
				customType: result.message.customType,
				content: result.message.content,
				details: result.message.details,
			});
		return { sections: systemPromptOptions.sections, message: result?.message };
	};

	/** Fire tool_call for a tool and input; returns the block result, if any. */
	const toolCall = async (toolName: string, input: Record<string, unknown>) =>
		(await fire("tool_call", { toolName, toolCallId: "t1", input })) as { block: true; reason: string } | undefined;

	return {
		pi,
		ctx,
		cwd,
		ui,
		fire,
		call,
		command,
		startRun,
		toolCall,
		tools,
		commands,
		shortcuts,
		flags,
		entryRenderers,
		sent,
		userMessages,
		execs,
		newSessions,
		entries,
		branch,
		active: () => [...active],
		activeHistory,
	};
}

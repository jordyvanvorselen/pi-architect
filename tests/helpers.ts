import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";

/** Theme stub that makes colors visible in snapshots: `<success>✓</success>`. */
export const tagTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<b>${text}</b>`,
};

/** Theme stub without any styling. */
export const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** Theme stub with real escape codes, to prove that width checks ignore them. */
export const ansiTheme = {
	fg: (_color: string, text: string) => `\x1b[38;5;75m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

/** Widths every line-based renderer must handle. */
export const WIDTHS = [30, 40, 80, 120] as const;

/** Remove `<color>` tags from tagTheme output. */
export const untag = (text: string) => text.replace(/<\/?[a-zA-Z]+>/g, "");

/** Lines without styling, from any of the themes above. */
export const plain = (lines: readonly string[]) => lines.map((l) => untag(stripTerminalSequences(l)));

/**
 * Render at each width and fail when any line is wider. `render` gets a theme with real escape codes,
 * so styling cannot hide an overflow. Returns the plain lines per width for further checks.
 */
export function assertFits(
	render: (width: number, theme: typeof ansiTheme) => readonly string[],
	widths: readonly number[] = WIDTHS,
): Map<number, string[]> {
	const result = new Map<number, string[]>();
	for (const width of widths) {
		const lines = render(width, ansiTheme);
		lines.forEach((line, i) =>
			assert.ok(
				visibleWidth(line) <= width,
				`line ${i} is ${visibleWidth(line)} wide at width ${width}: ${JSON.stringify(stripTerminalSequences(line))}`,
			),
		);
		result.set(width, plain(lines));
	}
	return result;
}

/** `assertFits` for a component. */
export function assertComponentFits(component: Component, widths: readonly number[] = WIDTHS): Map<number, string[]> {
	return assertFits((width) => component.render(width), widths);
}

type Answer = string | boolean | undefined;

export interface PromptCall {
	kind: "select" | "confirm" | "input" | "editor";
	title: string;
	detail?: string | string[];
	signal?: AbortSignal;
}

/**
 * A fake `ctx.ui` that records what the extension shows and answers blocking prompts from a script.
 * A prompt without a scripted answer fails the test, so unexpected dialogs do not go unnoticed.
 */
export class FakeUi {
	readonly notifications: { message: string; type: string | undefined }[] = [];
	readonly statuses = new Map<string, string | undefined>();
	readonly widgets = new Map<string, string[] | Component | undefined>();
	readonly prompts: PromptCall[] = [];
	readonly theme = plainTheme;
	renders = 0;
	private readonly answers: Record<PromptCall["kind"], Answer[]> = { select: [], confirm: [], input: [], editor: [] };

	constructor(script: Partial<Record<PromptCall["kind"], Answer[]>> = {}) {
		for (const [kind, answers] of Object.entries(script)) this.answers[kind as PromptCall["kind"]].push(...answers!);
	}

	/** Queue more answers. */
	script(script: Partial<Record<PromptCall["kind"], Answer[]>>): this {
		for (const [kind, answers] of Object.entries(script)) this.answers[kind as PromptCall["kind"]].push(...answers!);
		return this;
	}

	private answer(call: PromptCall): Answer {
		this.prompts.push(call);
		const queue = this.answers[call.kind];
		if (!queue.length) throw new Error(`unexpected ${call.kind}: ${call.title}`);
		return queue.shift();
	}

	/** True when every scripted answer was used. */
	get done(): boolean {
		return Object.values(this.answers).every((q) => q.length === 0);
	}

	notify = (message: string, type?: string) => {
		this.notifications.push({ message, type });
	};
	setStatus = (key: string, text: string | undefined) => {
		this.statuses.set(key, text);
	};
	setWidget = (key: string, content: unknown) => {
		if (typeof content === "function") {
			const tui = { requestRender: () => this.renders++ };
			this.widgets.set(key, (content as (tui: unknown, theme: unknown) => Component)(tui, this.theme));
		} else this.widgets.set(key, content as string[] | undefined);
	};
	select = async (title: string, options: string[], opts?: { signal?: AbortSignal }) =>
		this.answer({ kind: "select", title, detail: options, ...(opts?.signal ? { signal: opts.signal } : {}) }) as
			string | undefined;
	confirm = async (title: string, message: string) => Boolean(this.answer({ kind: "confirm", title, detail: message }));
	input = async (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) =>
		this.answer({
			kind: "input",
			title,
			...(placeholder ? { detail: placeholder } : {}),
			...(opts?.signal ? { signal: opts.signal } : {}),
		}) as string | undefined;
	editor = async (title: string, prefill?: string) =>
		this.answer({ kind: "editor", title, ...(prefill ? { detail: prefill } : {}) }) as string | undefined;
	setTitle = () => {};

	/** Render a widget component (or return its lines) at a width. */
	widgetLines(key: string, width = 120): string[] | undefined {
		const widget = this.widgets.get(key);
		if (!widget) return undefined;
		return plain(Array.isArray(widget) ? widget : widget.render(width));
	}
}

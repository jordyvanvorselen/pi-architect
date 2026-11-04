import { Key, matchesKey, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { DecisionAnswer, DecisionRequest } from "../../decision.ts";
import { InputGrace } from "../grace.ts";
import { InlineEditor } from "../inline-editor.ts";
import type { Paint } from "../paint.ts";
import type { ScreenOptions } from "../screen-options.ts";
import { inlineRoom } from "../room.ts";
import { paintLine } from "../spans.ts";
import { renderDecision, type DecisionMode } from "./card.ts";

/**
 * The interactive decision card. ←/→, tab and 1–4 move between options; ↵ chooses; `c` chooses with a
 * comment, `n` proposes an own option and `?` asks a question, each in an inline editor; `b` opens the board
 * over the card; esc closes.
 * Right after the card opens, ↵, `c`, `n` and `?` are ignored for a moment (see `InputGrace`).
 * Calls `done` once, with the answer or undefined.
 */
export class DecisionCard implements Component, Focusable {
	private readonly tui: TUI;
	private readonly paint: Paint;
	private readonly request: DecisionRequest;
	private readonly done: (answer: DecisionAnswer | undefined) => void;
	private focus: number;
	private mode: DecisionMode = "browse";
	/** esc was pressed in browse mode: the card asks before it closes. */
	private closing = false;
	private editor: InlineEditor | undefined;
	/** What the user typed per editor, kept when they step back with esc. */
	private readonly drafts = new Map<DecisionMode, string>();
	private cache: { width: number; rows: number; lines: string[] } | undefined;
	private hasFocus = false;
	private readonly grace: InputGrace;
	private readonly board: (() => void) | undefined;

	constructor(
		tui: TUI,
		paint: Paint,
		request: DecisionRequest,
		done: (answer: DecisionAnswer | undefined) => void,
		{ board, ...grace }: ScreenOptions = {},
	) {
		this.grace = new InputGrace(grace);
		this.board = board;
		this.tui = tui;
		this.paint = paint;
		this.request = request;
		this.done = done;
		const options = request.decision.options;
		this.focus = Math.max(
			0,
			options.findIndex((o) => o.id === request.decision.recommendation),
		);
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(value: boolean) {
		this.hasFocus = value;
		if (this.editor) this.editor.focused = value;
	}

	/** The option that has focus, and what the user is doing. For tests and the tool row. */
	get state(): { focus: string; mode: DecisionMode } {
		return { focus: this.request.decision.options[this.focus]!.id, mode: this.mode };
	}

	private changed(): void {
		this.cache = undefined;
		this.tui.requestRender();
	}

	private move(by: number): void {
		const count = this.request.decision.options.length;
		this.focus = (this.focus + by + count) % count;
		this.changed();
	}

	private open(mode: Exclude<DecisionMode, "browse">): void {
		this.mode = mode;
		this.editor = new InlineEditor(this.tui, this.paint, this.drafts.get(mode) ?? "", (text) => this.submit(text));
		this.editor.focused = this.hasFocus;
		this.changed();
	}

	private close(): void {
		if (this.editor) this.drafts.set(this.mode, this.editor.text);
		this.editor = undefined;
		this.mode = "browse";
		this.changed();
	}

	private submit(text: string): void {
		const trimmed = text.trim();
		const option = this.request.decision.options[this.focus]!.id;
		if (this.mode === "comment") this.done({ kind: "choose", option, ...(trimmed ? { comment: trimmed } : {}) });
		else if (!trimmed) this.changed();
		else if (this.mode === "own") this.done({ kind: "own", text: trimmed });
		else this.done({ kind: "ask", question: trimmed });
	}

	handleInput(data: string): void {
		if (this.editor) {
			if (matchesKey(data, Key.escape)) this.close();
			else {
				this.editor.handleInput(data);
				this.changed();
			}
			return;
		}
		if (this.closing) {
			// A stray ↵ must not close the card either: closing stops the agent.
			if (matchesKey(data, Key.enter)) {
				if (!this.grace.active) this.done(undefined);
			} else if (matchesKey(data, Key.escape)) {
				this.closing = false;
				this.changed();
			}
			return;
		}
		const count = this.request.decision.options.length;
		if (matchesKey(data, Key.left) || matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab"))) this.move(-1);
		else if (matchesKey(data, Key.right) || matchesKey(data, Key.down) || matchesKey(data, Key.tab)) this.move(1);
		else if (/^[1-4]$/.test(data) && Number(data) <= count) this.move(Number(data) - 1 - this.focus);
		else if (matchesKey(data, Key.escape)) {
			this.closing = true;
			this.changed();
		} else if (matchesKey(data, "b") && this.board) this.board();
		else if (this.grace.active) return;
		else if (matchesKey(data, Key.enter))
			this.done({ kind: "choose", option: this.request.decision.options[this.focus]!.id });
		else if (matchesKey(data, "c")) this.open("comment");
		else if (matchesKey(data, "n")) this.open("own");
		else if (matchesKey(data, "?") || matchesKey(data, "shift+/")) this.open("ask");
	}

	render(width: number): string[] {
		// The room changes with Pi's chrome, e.g. when the loader or a queued message shows.
		const rows = Math.max(10, inlineRoom(this.tui, this, width));
		if (this.cache?.width === width && this.cache.rows === rows) return this.cache.lines;
		const { decision, index, total, expected, feature } = this.request;
		const editor = this.editor;
		const lines = renderDecision(
			{
				decision,
				focus: this.focus,
				mode: this.mode,
				board: this.board !== undefined,
				...(index !== undefined ? { index } : {}),
				...(total !== undefined ? { total } : {}),
				...(expected !== undefined ? { expected } : {}),
				...(feature ? { feature } : {}),
				...(editor ? { editor: (w: number) => editor.lines(w) } : {}),
				maxRows: rows,
				...(this.closing ? { closing: true } : {}),
			},
			width,
		).map((line) => paintLine(line, this.paint));
		this.cache = { width, rows, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

import { Key, matchesKey, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { ReviewAnswer, ReviewRequest } from "../../review.ts";
import { InputGrace } from "../grace.ts";
import { InlineEditor } from "../inline-editor.ts";
import type { Paint } from "../paint.ts";
import type { ScreenOptions } from "../screen-options.ts";
import { paintLine, type Line } from "../spans.ts";
import type { ReviewBody } from "./common.ts";
import { renderReview, reviewGeometry, type ReviewMode } from "./screen.ts";

/** Rows kept free above the screen, so the transcript stays in view. */
const SPARE_ROWS = 4;

/**
 * The interactive Phase Review screen. ↑/↓, PgUp/PgDn and Home/End scroll; ↵ approves; `r` opens an inline
 * editor for the requested changes; `b` opens the board over the screen; esc steps back from the editor or
 * closes the screen. Right after the screen opens, ↵ and `r` are ignored for a moment (see `InputGrace`).
 * Calls `done` once, with the verdict or undefined.
 */
export class ReviewScreen implements Component, Focusable {
	private readonly tui: TUI;
	private readonly paint: Paint;
	private readonly request: ReviewRequest;
	private readonly body: ReviewBody;
	private readonly done: (answer: ReviewAnswer | undefined) => void;
	private mode: ReviewMode = "browse";
	private editor: InlineEditor | undefined;
	private draft = "";
	private scroll = 0;
	/** Body lines in view and the furthest scroll, from the last render, for paging. */
	private viewport = 10;
	private maxScroll = 0;
	private bodyCache: { width: number; lines: Line[] } | undefined;
	private cache: { width: number; lines: string[] } | undefined;
	private hasFocus = false;
	private readonly grace: InputGrace;
	private readonly board: (() => void) | undefined;

	constructor(
		tui: TUI,
		paint: Paint,
		request: ReviewRequest,
		body: ReviewBody,
		done: (answer: ReviewAnswer | undefined) => void,
		{ board, ...grace }: ScreenOptions = {},
	) {
		this.grace = new InputGrace(grace);
		this.board = board;
		this.tui = tui;
		this.paint = paint;
		this.request = request;
		this.body = body;
		this.done = done;
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(value: boolean) {
		this.hasFocus = value;
		if (this.editor) this.editor.focused = value;
	}

	/** Scroll position and mode. For tests. */
	get state(): { scroll: number; mode: ReviewMode } {
		return { scroll: this.scroll, mode: this.mode };
	}

	private changed(): void {
		this.cache = undefined;
		this.tui.requestRender();
	}

	private scrollTo(line: number): void {
		const next = Math.min(Math.max(0, line), this.maxScroll);
		if (next === this.scroll) return;
		this.scroll = next;
		this.changed();
	}

	handleInput(data: string): void {
		if (this.editor) {
			if (matchesKey(data, Key.escape)) {
				this.draft = this.editor.text;
				this.editor = undefined;
				this.mode = "browse";
				this.changed();
			} else {
				this.editor.handleInput(data);
				this.changed();
			}
			return;
		}
		const page = Math.max(1, this.viewport - 2);
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.scrollTo(this.scroll - 1);
		else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.scrollTo(this.scroll + 1);
		else if (matchesKey(data, Key.pageUp)) this.scrollTo(this.scroll - page);
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) this.scrollTo(this.scroll + page);
		else if (matchesKey(data, Key.home)) this.scrollTo(0);
		else if (matchesKey(data, Key.end)) this.scrollTo(this.maxScroll);
		else if (matchesKey(data, Key.escape)) this.done(undefined);
		else if (matchesKey(data, "b") && this.board) this.board();
		else if (this.grace.active) return;
		else if (matchesKey(data, Key.enter)) this.done({ verdict: "approved" });
		else if (matchesKey(data, "r")) {
			this.mode = "changes";
			this.editor = new InlineEditor(this.tui, this.paint, this.draft, (text) => {
				const comment = text.trim();
				if (comment) this.done({ verdict: "changes", comment });
				else this.changed();
			});
			this.editor.focused = this.hasFocus;
			this.changed();
		}
	}

	private bodyLines(inner: number): Line[] {
		if (this.bodyCache?.width !== inner)
			this.bodyCache = { width: inner, lines: this.body(this.request.arch, inner, this.paint, this.request) };
		return this.bodyCache.lines;
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const { arch, phase, summary } = this.request;
		const editor = this.editor;
		const layout = renderReview(
			{
				phase,
				...(arch.feature ? { feature: arch.feature } : {}),
				...(summary ? { summary } : {}),
				body: this.bodyLines(reviewGeometry(width).inner),
				scroll: this.scroll,
				mode: this.mode,
				board: this.board !== undefined,
				...(editor ? { editor: (w: number) => editor.lines(w) } : {}),
				maxRows: Math.max(12, this.tui.terminal.rows - SPARE_ROWS),
			},
			width,
		);
		this.scroll = layout.scroll;
		this.viewport = layout.viewport;
		this.maxScroll = layout.maxScroll;
		const lines = layout.lines.map((line) => paintLine(line, this.paint));
		this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
		this.bodyCache = undefined;
	}
}

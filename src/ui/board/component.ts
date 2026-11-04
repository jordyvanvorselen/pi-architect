import {
	Key,
	matchesKey,
	stripTerminalSequences,
	visibleWidth,
	type Component,
	type Focusable,
	type MarkdownTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { DiagramView } from "../../diagram/index.ts";
import { renderPlan } from "../../plan/render.ts";
import { InlineEditor } from "../inline-editor.ts";
import type { Paint } from "../paint.ts";
import {
	boxRow,
	clipLine,
	edge,
	hints,
	innerWidth,
	lineWidth,
	paintLine,
	raw,
	sp,
	wrapAfter,
	type Line,
	type Span,
} from "../spans.ts";
import { renderSteps } from "../stepper.ts";
import type { BoardComment } from "./comments.ts";
import {
	summarize,
	tabContent,
	TABS,
	type BoardData,
	type BoardItem,
	type BoardTab,
	type TabContent,
} from "./model.ts";
import {
	boardMargin,
	emptyLines,
	GUTTER,
	hintRows,
	MAX_TEXT,
	scrollLabel,
	tabBar,
	tabRule,
	type HintPair,
	type TabRange,
} from "./screen.ts";

export interface BoardOptions {
	/** The current data. Read again on `update()`. */
	data: () => BoardData;
	markdown: MarkdownTheme;
	/** The tab to open on. Default: the tab of the phase the agent works on. */
	tab?: BoardTab;
	/** No comments, also in architect mode. For a board opened over a review screen or decision card. */
	readOnly?: boolean;
	/** Comments to start with: the draft of a board that closed for a decision card or review screen. */
	comments?: readonly BoardComment[];
	/** Called once, with the comments to send. Empty when there are none, or when the board was suspended. */
	done: (comments: BoardComment[]) => void;
}

/** What the last render laid out where, for the keys and the mouse. */
interface Frame {
	width: number;
	height: number;
	lines: string[];
	tabRow: number;
	tabOffset: number;
	tabRanges: TabRange[];
	bodyTop: number;
	viewport: number;
	scroll: number;
	maxScroll: number;
	/** Per body line, the index of the item it belongs to, or -1. */
	owners: number[];
	/** Per item, its first and one past its last body line. */
	ranges: { start: number; end: number }[];
	bottomRow: number;
	commentRanges: { key: string; start: number; end: number }[];
}

/** Lines scrolled per wheel notch. */
const WHEEL_LINES = 3;
/** Body rows the board keeps even on a short terminal. */
const MIN_BODY = 3;

const DIAGRAM_KEYS = new Set(["h", "l", "0", "$"]);

/**
 * `/architect board`: the whole architecture on one fullscreen overlay, with a tab per part.
 *
 * - 1–7, tab and shift+tab (or ←/→) switch tabs. ↑/↓ and j/k move between items and scroll long ones;
 *   PgUp/PgDn, Home/End and the wheel scroll.
 * - ↵ opens the selected item: a decision shows its options as cards, a slice its steps, a diagram opens
 *   in a detail view where ←/→ scroll it sideways. `e` opens or closes every item on the tab.
 * - `c` writes a comment on the selected item, `x` removes it, `m` jumps to the next one. esc or q closes
 *   the board. With comments it first asks in the bottom bar: ↵ hands them to `done`, `d` discards them
 *   and esc goes back to the board. In build mode, or when opened with `readOnly`, the board is read-only.
 */
export class BoardScreen implements Component, Focusable {
	readonly capturesViewportInput = true;
	private readonly tui: TUI;
	private readonly paint: Paint;
	private readonly options: BoardOptions;
	private data: BoardData;
	private tab: BoardTab;
	private readonly selected = new Map<BoardTab, string>();
	private readonly scrolls = new Map<BoardTab, number>();
	private readonly expanded = new Set<string>();
	private readonly comments = new Map<string, BoardComment>();
	/** What the user typed per item and left with esc, back when they press `c` on it again. */
	private readonly unsaved = new Map<string, string>();
	private detail: { key: string; view: DiagramView; scroll: number } | undefined;
	private editor: { item: BoardItem; editor: InlineEditor; existing: boolean } | undefined;
	/** Scroll the selected item into view on the next layout. */
	private follow = true;
	private contents = new Map<BoardTab, TabContent>();
	private itemLines = new Map<string, Line[]>();
	private draft: string | undefined;
	private frame: Frame | undefined;
	/** The width of the last render, to lay out for keys that come before the next one. */
	private width = 80;
	private hasFocus = false;
	private closed = false;
	/** Closing with comments: the bottom bar asks whether to send them. */
	private confirming = false;

	constructor(tui: TUI, paint: Paint, options: BoardOptions) {
		this.tui = tui;
		this.paint = paint;
		this.options = options;
		this.data = options.data();
		this.tab = options.tab ?? this.defaultTab();
		for (const comment of options.comments ?? []) this.comments.set(comment.key, comment);
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(value: boolean) {
		this.hasFocus = value;
		if (this.editor) this.editor.editor.focused = value;
	}

	/** Where the board stands. For tests. */
	get state(): {
		tab: BoardTab;
		selected: string | undefined;
		scroll: number;
		expanded: string[];
		detail: string | undefined;
		detailScroll: number | undefined;
		editing: string | undefined;
		comments: BoardComment[];
		confirming: boolean;
	} {
		return {
			tab: this.tab,
			selected: this.selectedItem()?.key,
			scroll: this.frame?.scroll ?? this.scrolls.get(this.tab) ?? 0,
			expanded: [...this.expanded],
			detail: this.detail?.key,
			detailScroll: this.detail?.view.scroll,
			editing: this.editor?.item.key,
			comments: [...this.comments.values()],
			confirming: this.confirming,
		};
	}

	private get readOnly(): boolean {
		return this.options.readOnly === true || this.data.mode === "build";
	}

	private defaultTab(): BoardTab {
		const arch = this.data.arch;
		// Build mode is for reading the plan; an approved architecture has nothing left to fill in.
		if (!arch || arch.approvedAt !== undefined || (this.data.mode === "build" && this.data.plan)) return "plan";
		const byPhase: Record<string, BoardTab> = {
			frame: "brief",
			explore: "explore",
			decide: "decisions",
			design: "diagrams",
			slice: "slices",
			blueprint: "plan",
		};
		return byPhase[arch.phase]!;
	}

	/** Read the data again, e.g. after the agent changed the architecture, and redraw. */
	update(): void {
		this.data = this.options.data();
		this.clearCaches();
		if (this.detail && !this.content(this.tab).items.some((i) => i.key === this.detail!.key)) this.detail = undefined;
		this.tui.requestRender();
	}

	private clearCaches(): void {
		this.contents = new Map();
		this.itemLines = new Map();
		this.draft = undefined;
		this.frame = undefined;
	}

	invalidate(): void {
		this.clearCaches();
		this.detail?.view.invalidate();
	}

	private changed(): void {
		this.frame = undefined;
		this.tui.requestRender();
	}

	/** esc or q: close at once, or ask first when there are comments to send. */
	private close(): void {
		if (this.closed) return;
		if (!this.readOnly && this.comments.size) {
			this.confirming = true;
			this.changed();
		} else this.finish([]);
	}

	/**
	 * Close the board without sending anything, e.g. because a decision card or review screen opens and must
	 * not open behind it. Returns the unsent comments, with a comment still in the editor, to keep as a draft.
	 */
	suspend(): BoardComment[] {
		if (this.closed) return [];
		const editor = this.editor;
		if (editor && editor.editor.text.trim()) this.saveComment(editor.item, editor.editor.text);
		const comments = this.readOnly ? [] : [...this.comments.values()];
		this.finish([]);
		return comments;
	}

	private finish(comments: BoardComment[]): void {
		if (this.closed) return;
		this.closed = true;
		this.confirming = false;
		this.options.done(comments);
	}

	// ── Content ──────────────────────────────────────────────────────────────────────────────────

	private content(tab: BoardTab): TabContent {
		let content = this.contents.get(tab);
		if (!content) {
			content = tabContent(tab, this.data, { paint: this.paint, markdown: this.options.markdown }, () => {
				this.draft ??= renderPlan(this.data.arch!, this.data.session ? { session: this.data.session } : {});
				return this.draft;
			});
			this.contents.set(tab, content);
		}
		return content;
	}

	private items(tab = this.tab): BoardItem[] {
		return this.content(tab).items;
	}

	private selectedIndex(tab = this.tab): number {
		const items = this.items(tab);
		const key = this.selected.get(tab);
		const index = items.findIndex((i) => i.key === key);
		return index >= 0 ? index : items.length ? 0 : -1;
	}

	private selectedItem(): BoardItem | undefined {
		return this.items()[this.selectedIndex()];
	}

	private linesOf(item: BoardItem, width: number): Line[] {
		const expanded = this.expanded.has(item.key);
		const cacheKey = `${this.tab}|${item.key}|${width}|${expanded}`;
		let lines = this.itemLines.get(cacheKey);
		if (!lines) {
			lines = item.lines(width, expanded);
			this.itemLines.set(cacheKey, lines);
		}
		return lines;
	}

	// ── Layout ───────────────────────────────────────────────────────────────────────────────────

	private height(): number {
		const { rows, columns } = this.tui.terminal;
		const m = boardMargin(columns, rows);
		return Math.max(6, rows - m.top - m.bottom);
	}

	private commentLines(key: string, width: number): Line[] {
		const comment = this.comments.get(key);
		if (!comment) return [];
		return wrapAfter([sp("✎ ", "warning")], comment.text, width, "text");
	}

	/**
	 * The body of the current tab: its lines, which item each belongs to, and the item ranges. Text sits in
	 * the centered `column`; a diagram's detail view grows up to `inner` columns when the drawing needs it.
	 */
	private body(
		inner: number,
		column: number,
	): { lines: Line[]; owners: number[]; ranges: { start: number; end: number }[] } {
		const lines: Line[] = [];
		const owners: number[] = [];
		const ranges: { start: number; end: number }[] = [];
		const push = (line: Line, owner: number) => {
			lines.push(line);
			owners.push(owner);
		};
		const content = this.content(this.tab);
		const items = content.items;
		const selected = this.selectedIndex();
		const detail = this.detail;
		if (detail) {
			const index = items.findIndex((i) => i.key === detail.key);
			const item = items[index]!;
			const head: Line[] = [
				[
					sp("◂ ", "accent"),
					sp("Diagrams", "muted"),
					sp("  /  ", "dim"),
					sp(item.ref, "dim"),
					sp("  "),
					sp(item.label ?? "", "text", true),
				],
				[],
			];
			const drawing = Math.max(...item.diagram!.body.split("\n").map((l) => visibleWidth(l)));
			const width = Math.min(inner, Math.max(column, drawing));
			const left: Span[] = [sp(" ".repeat(Math.floor((inner - width) / 2)))];
			for (const line of head) push([...left, ...line], -1);
			ranges[index] = { start: lines.length, end: lines.length };
			for (const line of detail.view.render(width)) push([...left, raw(line, stripTerminalSequences(line))], index);
			const notes = this.commentLines(item.key, width);
			if (notes.length) push([], index);
			for (const line of notes) push([...left, ...line], index);
			ranges[index]!.end = lines.length;
			return { lines, owners, ranges };
		}
		const width = column;
		const left: Span[] = width < inner ? [sp(" ".repeat(Math.floor((inner - width) / 2)))] : [];
		const text = Math.max(1, width - GUTTER);
		if (!items.length) {
			for (const line of emptyLines(content.empty!, width)) push([...left, ...line], -1);
			return { lines, owners, ranges };
		}
		const plain: Span = sp(" ".repeat(GUTTER));
		for (const line of content.head?.(text) ?? []) push([...left, plain, ...line], -1);
		const marked = items.length > 1;
		items.forEach((item, i) => {
			if (i) push([], -1);
			for (const line of item.before?.(text) ?? []) push([...left, plain, ...line], -1);
			const start = lines.length;
			const bar: Span = marked && i === selected ? sp("┃ ", "accent") : plain;
			for (const line of this.linesOf(item, text)) push([...left, bar, ...line], i);
			for (const line of this.commentLines(item.key, text)) push([...left, bar, ...line], i);
			ranges[i] = { start, end: lines.length };
		});
		return { lines, owners, ranges };
	}

	/** `Send 2 comments to the agent?  ↵ send  d discard  esc back`, shorter where that does not fit. */
	private confirmLine(inner: number): Line {
		const n = this.comments.size;
		const comments = n === 1 ? "1 comment" : `${n} comments`;
		const options: [string, HintPair[]][] = [
			[
				`Send ${comments} to the agent?`,
				[
					["↵", "send"],
					["d", "discard"],
					["esc", "back"],
				],
			],
			[
				`Send ${comments}?`,
				[
					["↵", "send"],
					["d", "discard"],
					["esc", "back"],
				],
			],
			[
				`Send ${n}?`,
				[
					["↵", "send"],
					["d", "discard"],
					["esc", "back"],
				],
			],
			[
				`Send ${n}?`,
				[
					["↵", ""],
					["d", ""],
					["esc", ""],
				],
			],
		];
		let line: Line = [];
		for (const [question, pairs] of options) {
			line = [sp(question, "warning", true), sp("  "), ...hints(pairs)];
			if (lineWidth(line) <= inner) return line;
		}
		return clipLine(line, inner);
	}

	private hints(inner: number, max: number): Line[] {
		if (this.confirming) return [this.confirmLine(inner)];
		if (this.editor)
			return hintRows(
				[
					[
						["↵", this.editor.existing ? "save · empty removes" : "save"],
						["shift+↵", "new line"],
						["esc", "back"],
					],
					[
						["↵", "save"],
						["esc", "back"],
					],
				],
				inner,
				max,
			);
		const count = this.comments.size;
		const close: HintPair = ["esc", count && !this.readOnly ? `close · ${count} to send` : "close"];
		const write = !this.readOnly && this.selectedItem() !== undefined;
		const hasComment = this.comments.has(this.selectedItem()?.key ?? "");
		if (this.detail)
			return hintRows(
				[
					[
						["←→", "scroll sideways"],
						["↑↓", "scroll"],
						...(write ? ([["c", hasComment ? "edit comment" : "comment"]] as const) : []),
						["esc", "back"],
					],
					[["←→", ""], ["↑↓", ""], ...(write ? ([["c", ""]] as const) : []), ["esc", "back"]],
				],
				inner,
				max,
			);
		const item = this.selectedItem();
		const open: HintPair[] = item?.diagram
			? [["↵", "full view"]]
			: item?.expandable
				? [["↵", this.expanded.has(item.key) ? "fold" : "open"]]
				: [];
		const long: HintPair[] = [
			["1-7", "tabs"],
			["↑↓", "move"],
			...open,
			...(write ? ([["c", hasComment ? "edit comment" : "comment"]] as const) : []),
			...(hasComment && !this.readOnly ? ([["x", "remove"]] as const) : []),
			...(count && !this.readOnly ? ([["m", "next comment"]] as const) : []),
			close,
		];
		const brief: HintPair[] = [
			["1-7", ""],
			["↑↓", ""],
			...open.map(([k]) => [k, ""] as const),
			...(write ? ([["c", "comment"]] as const) : []),
			["esc", "close"],
		];
		const tiny: HintPair[] = [
			["↑↓", ""],
			...open.map(([k]) => [k, ""] as const),
			...(write ? ([["c", ""]] as const) : []),
			["esc", ""],
		];
		return hintRows([long, brief, tiny], inner, max);
	}

	private layout(width: number): Frame {
		const total = Math.max(1, width);
		const height = this.height();
		const padX = total >= 60 ? 2 : 1;
		const inner = innerWidth(total, padX);
		const arch = this.data.arch;
		const row = (line: Line, side?: Span) => boxRow(line, total, "round", "border", padX, side);
		// Wide terminals center a reading column; the tab bar, the hints and the editor line up with it.
		const column = Math.min(inner, MAX_TEXT);
		const lead = Math.floor((inner - column) / 2);
		const centered = (line: Line, side?: Span) => row(lead ? [sp(" ".repeat(lead)), ...line] : line, side);

		// Top: title, phases, tabs and the rule under them.
		const title: Line = [sp("◆", "accent", true), sp(" Board", "accent", true)];
		const feature = arch?.feature || this.data.plan?.feature;
		if (feature) title.push(sp("  "), sp(feature, "text", true));
		const count = this.comments.size;
		const badge: Line = this.readOnly
			? [sp("read-only", "dim")]
			: count
				? [sp(`✎ ${count} to send`, "warning", true)]
				: [];
		const top: Line[] = [edge(total, "round", "border", "top", title, badge)];
		if (arch && height >= 16) {
			const status: Line =
				arch.approvedAt !== undefined
					? [sp("✓ plan approved", "success")]
					: arch.status === "review"
						? [sp("◉ awaiting your review", "warning")]
						: [];
			const room = column - (status.length ? lineWidth(status) + 3 : 0);
			const plainSteps = renderSteps(arch, room, { fg: (_c, t) => t, bold: (t) => t });
			const steps: Line = [raw(renderSteps(arch, room, this.paint), plainSteps)];
			const space = column - lineWidth(steps) - lineWidth(status);
			top.push(centered(status.length && space >= 3 ? [...steps, sp(" ".repeat(space)), ...status] : steps));
		}
		const summaries = Object.fromEntries(TABS.map((t) => [t, summarize(this.data, t)])) as Parameters<typeof tabBar>[0];
		const perTab: Partial<Record<BoardTab, number>> = {};
		for (const c of this.comments.values()) perTab[c.tab] = (perTab[c.tab] ?? 0) + 1;
		const bar = tabBar(summaries, this.tab, perTab, column);
		const tabRow = top.length;
		const tabOffset = 1 + padX + lead;
		top.push(centered(bar.line));
		top.push(
			tabRule(
				total,
				tabOffset,
				bar.ranges.find((r) => r.tab === this.tab),
			),
		);

		// Bottom: the editor while writing, the key hints, and the comments to send in the bottom edge.
		const editor = this.editor;
		const rule: Line = editor
			? edgeRule(total, [
					sp("✎ ", "warning"),
					sp("Comment on ", "accent"),
					sp(editor.item.ref, "accent", true),
					...(editor.item.label ? [sp(`  ${editor.item.label}`, "muted")] : []),
				])
			: [sp(`├${"─".repeat(Math.max(0, total - 2))}┤`, "border")];
		let written = editor ? editor.editor.lines(column).map((l) => centered(l)) : [];
		const room = () => height - top.length - 1 - written.length - 1;
		let keys = this.hints(column, room() - MIN_BODY >= 7 ? 2 : 1).map((l) => centered(l));
		// On a short terminal the body keeps a few rows: the rule goes first, then while writing the hints
		// and the editor's first lines, so the line with the cursor stays in view.
		let ruled = room() - keys.length >= MIN_BODY || editor !== undefined;
		if (editor && room() - keys.length < 1) keys = [];
		if (editor && room() < 1) written = written.slice(written.length - Math.max(1, written.length + room() - 1));
		if (!editor && room() - keys.length < MIN_BODY) ruled = false;
		const foot: Line[] = [...(ruled ? [rule] : []), ...written, ...keys];

		const body = this.body(inner, column);
		const viewport = Math.max(1, height - top.length - foot.length - 1);
		const maxScroll = Math.max(0, body.lines.length - viewport);
		let scroll = this.detail ? this.detail.scroll : (this.scrolls.get(this.tab) ?? 0);
		const sel = this.selectedIndex();
		const range = body.ranges[sel];
		if (this.follow && range && !this.detail) {
			let start = range.start;
			while (start > 0 && body.owners[start - 1] === -1 && body.lines[start - 1]!.length) start--;
			if (start < scroll) scroll = start;
			else if (range.end > scroll + viewport) scroll = Math.min(start, range.end - viewport);
		}
		this.follow = false;
		scroll = Math.min(Math.max(0, scroll), maxScroll);
		if (this.detail) this.detail.scroll = scroll;
		else this.scrolls.set(this.tab, scroll);

		const scrollable = maxScroll > 0;
		const thumb = Math.max(1, Math.round((viewport * viewport) / Math.max(1, body.lines.length)));
		const thumbAt = maxScroll ? Math.round((scroll / maxScroll) * (viewport - thumb)) : 0;
		const side = (i: number): Span | undefined =>
			scrollable ? (i >= thumbAt && i < thumbAt + thumb ? sp("┃", "accent") : sp("│", "borderMuted")) : undefined;
		const view: Line[] = [];
		for (let i = 0; i < viewport; i++) view.push(row(body.lines[scroll + i] ?? [], side(i)));

		const refs: Line = [];
		const commentRanges: Frame["commentRanges"] = [];
		if (count && !this.readOnly) {
			let at = 3;
			refs.push(sp("✎ ", "warning"));
			at += 2;
			[...this.comments.values()].forEach((c, i) => {
				if (i) {
					refs.push(sp(" · ", "dim"));
					at += 3;
				}
				const w = lineWidth([sp(c.ref)]);
				refs.push(sp(c.ref, "warning"));
				commentRanges.push({ key: c.key, start: at, end: at + w });
				at += w;
			});
		}
		const bottom = edge(total, "round", "border", "bottom", refs, scrollLabel(scroll, viewport, body.lines.length));
		const shown = lineWidth(bottom.slice(1, -1)) > 0 && bottom.length > 3;
		const lines = [...top, ...view, ...foot, bottom].map((l) => paintLine(l, this.paint));
		return {
			width: total,
			height,
			lines,
			tabRow,
			tabOffset,
			tabRanges: bar.ranges,
			bodyTop: top.length,
			viewport,
			scroll,
			maxScroll,
			owners: body.owners,
			ranges: body.ranges,
			bottomRow: lines.length - 1,
			commentRanges: shown ? commentRanges.filter((r) => r.end < total - 1) : [],
		};
	}

	render(width: number): string[] {
		this.width = width;
		// A resize changes the height without a new width, so the frame is kept per width and height.
		if (this.frame?.width !== width || this.frame.height !== this.height()) this.frame = this.layout(width);
		return this.frame.lines;
	}

	// ── Actions ──────────────────────────────────────────────────────────────────────────────────

	private setTab(tab: BoardTab): void {
		if (tab === this.tab && !this.detail) return;
		this.tab = tab;
		this.detail = undefined;
		this.follow = true;
		this.changed();
	}

	private select(index: number, follow = true): void {
		const item = this.items()[index];
		if (!item) return;
		this.selected.set(this.tab, item.key);
		this.follow = follow;
		this.changed();
	}

	private scrollBy(lines: number, keepSelection = false): void {
		const frame = this.frameNow();
		const next = Math.min(Math.max(0, frame.scroll + lines), frame.maxScroll);
		if (this.detail) this.detail.scroll = next;
		else this.scrolls.set(this.tab, next);
		if (!keepSelection && !this.detail) {
			// Keep the selection when it is still in view, else select the first item in view.
			const range = frame.ranges[this.selectedIndex()];
			const visible = (r: { start: number; end: number }) => r.end > next && r.start < next + frame.viewport;
			if (!range || !visible(range)) {
				const index = frame.ranges.findIndex((r) => r && visible(r) && r.start >= next);
				const fallback = frame.ranges.findIndex((r) => r && visible(r));
				const pick = index >= 0 ? index : fallback;
				if (pick >= 0) this.selected.set(this.tab, this.items()[pick]!.key);
			}
		}
		this.changed();
	}

	private frameNow(): Frame {
		if (!this.frame) this.frame = this.layout(this.width);
		return this.frame;
	}

	/** ↓: scroll through a long item first, then move to the next one. */
	private down(): void {
		const frame = this.frameNow();
		const index = this.selectedIndex();
		const range = frame.ranges[index];
		if (this.detail || !range) return this.scrollBy(1, true);
		if (range.end > frame.scroll + frame.viewport) return this.scrollBy(1, true);
		if (index + 1 < this.items().length) return this.select(index + 1);
		this.scrollBy(1, true);
	}

	private up(): void {
		const frame = this.frameNow();
		const index = this.selectedIndex();
		const range = frame.ranges[index];
		if (this.detail || !range) return this.scrollBy(-1, true);
		if (range.start < frame.scroll) return this.scrollBy(-1, true);
		if (index > 0) return this.select(index - 1);
		this.scrollBy(-1, true);
	}

	private activate(): void {
		const item = this.selectedItem();
		if (!item || this.detail) return;
		if (item.diagram) {
			this.detail = { key: item.key, view: new DiagramView(item.diagram, this.paint), scroll: 0 };
			this.changed();
		} else if (item.expandable) {
			if (this.expanded.has(item.key)) this.expanded.delete(item.key);
			else this.expanded.add(item.key);
			this.follow = true;
			this.changed();
		}
	}

	private toggleAll(): void {
		const items = this.items().filter((i) => i.expandable);
		if (!items.length) return;
		const open = items.some((i) => !this.expanded.has(i.key));
		for (const item of items) {
			if (open) this.expanded.add(item.key);
			else this.expanded.delete(item.key);
		}
		this.follow = true;
		this.changed();
	}

	private startComment(): void {
		const item = this.selectedItem();
		if (!item || this.readOnly) return;
		const existing = this.comments.get(item.key);
		const text = this.unsaved.get(item.key) ?? existing?.text ?? "";
		const editor = new InlineEditor(this.tui, this.paint, text, (value) => this.saveComment(item, value));
		editor.focused = this.hasFocus;
		this.editor = { item, editor, existing: existing !== undefined };
		this.changed();
	}

	private saveComment(item: BoardItem, text: string): void {
		const comment = text.trim();
		this.unsaved.delete(item.key);
		if (comment)
			this.comments.set(item.key, {
				tab: this.tab,
				key: item.key,
				ref: item.ref,
				...(item.label ? { label: item.label } : {}),
				text: comment,
			});
		else this.comments.delete(item.key);
		this.editor = undefined;
		this.follow = true;
		this.changed();
	}

	private removeComment(): void {
		const item = this.selectedItem();
		if (!item || !this.comments.delete(item.key)) return;
		this.changed();
	}

	/** Select the item of the comment after the selected one, on whatever tab it is. */
	private nextComment(): void {
		const list = [...this.comments.values()];
		if (!list.length) return;
		const at = list.findIndex((c) => c.key === this.selectedItem()?.key && c.tab === this.tab);
		this.jumpTo(list[(at + 1) % list.length]!);
	}

	private jumpTo(comment: BoardComment): void {
		this.tab = comment.tab;
		this.detail = undefined;
		this.selected.set(comment.tab, comment.key);
		this.follow = true;
		this.changed();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.confirming) {
			if (matchesKey(data, Key.enter)) this.finish([...this.comments.values()]);
			else if (data === "d") this.finish([]);
			else if (matchesKey(data, Key.escape)) {
				this.confirming = false;
				this.changed();
			}
			return;
		}
		const editor = this.editor;
		if (editor) {
			if (matchesKey(data, Key.escape)) {
				// Back to the board. The text waits for the next `c` on this item, unsaved.
				if (editor.editor.text.trim()) this.unsaved.set(editor.item.key, editor.editor.text);
				else this.unsaved.delete(editor.item.key);
				this.editor = undefined;
				this.changed();
			} else {
				editor.editor.handleInput(data);
				if (this.editor) this.changed();
			}
			return;
		}
		const frame = this.frameNow();
		const page = Math.max(1, frame.viewport - 2);
		const tabIndex = TABS.indexOf(this.tab);
		if (this.detail) {
			if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || DIAGRAM_KEYS.has(data)) {
				this.detail.view.handleInput(data);
				this.changed();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.backspace) || data === "q") {
				this.detail = undefined;
				this.follow = true;
				this.changed();
				return;
			}
		}
		if (/^[1-7]$/.test(data)) this.setTab(TABS[Number(data) - 1]!);
		else if (matchesKey(data, Key.tab) || (!this.detail && matchesKey(data, Key.right)))
			this.setTab(TABS[(tabIndex + 1) % TABS.length]!);
		else if (matchesKey(data, Key.shift("tab")) || (!this.detail && matchesKey(data, Key.left)))
			this.setTab(TABS[(tabIndex + TABS.length - 1) % TABS.length]!);
		else if (matchesKey(data, Key.down) || data === "j") this.down();
		else if (matchesKey(data, Key.up) || data === "k") this.up();
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) this.scrollBy(page);
		else if (matchesKey(data, Key.pageUp)) this.scrollBy(-page);
		else if (matchesKey(data, Key.home) || data === "g") {
			if (this.detail) this.scrollBy(-frame.scroll, true);
			else this.select(0);
		} else if (matchesKey(data, Key.end) || data === "G") {
			if (this.detail) this.scrollBy(frame.maxScroll, true);
			else this.select(this.items().length - 1);
		} else if (matchesKey(data, Key.enter)) this.activate();
		else if (data === "e") this.toggleAll();
		else if (data === "c") this.startComment();
		else if (data === "x" && !this.readOnly) this.removeComment();
		else if (data === "m" && !this.readOnly) this.nextComment();
		else if (matchesKey(data, Key.escape) || data === "q") this.close();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		const frame = this.frameNow();
		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? 0;
			if (this.detail && event.shift) {
				this.detail.view.handleInput(delta > 0 ? "l" : "h");
				this.changed();
			} else this.scrollBy(Math.sign(delta) * Math.max(WHEEL_LINES, Math.abs(delta)));
			return { handled: true };
		}
		if (event.type !== "click" || event.button !== "left" || this.editor || this.confirming)
			return { handled: true, render: false };
		const { x, y } = event;
		if (y === frame.tabRow) {
			const hit = frame.tabRanges.find((r) => x >= frame.tabOffset + r.start && x < frame.tabOffset + r.end);
			if (hit) this.setTab(hit.tab);
			return { handled: true };
		}
		if (y === frame.bottomRow) {
			const hit = frame.commentRanges.find((r) => x >= r.start && x < r.end);
			const comment = hit && this.comments.get(hit.key);
			if (comment) this.jumpTo(comment);
			return { handled: true };
		}
		if (y >= frame.bodyTop && y < frame.bodyTop + frame.viewport && !this.detail) {
			const owner = frame.owners[frame.scroll + (y - frame.bodyTop)] ?? -1;
			if (owner >= 0) {
				const again = owner === this.selectedIndex();
				this.select(owner, false);
				if (again || (event.clickCount ?? 1) >= 2) this.activate();
			}
		}
		return { handled: true };
	}
}

/** `├─ label ─────┤`: a rule across the frame with a label in it. */
function edgeRule(total: number, label: Line): Line {
	const inner = Math.max(0, total - 2);
	if (total < 8) return [sp(`├${"─".repeat(inner)}┤`, "border")];
	const head: Line = [sp("├─ ", "border"), ...clipLine(label, total - 5), sp(" ", "border")];
	return [...head, sp(`${"─".repeat(Math.max(0, total - lineWidth(head) - 1))}┤`, "border")];
}

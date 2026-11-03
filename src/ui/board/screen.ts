import type { OverlayOptions } from "@earendil-works/pi-tui";
import type { Color } from "../paint.ts";
import { clipLine, hintLines, hints, lineWidth, sp, wrap, type Line, type Span } from "../spans.ts";
import { TAB_NAME, TAB_SHORT, TABS, type BoardTab, type EmptyState, type TabSummary } from "./model.ts";

/** Text lines on the board never get wider than this; wide terminals center them. Diagrams use the full width. */
export const MAX_TEXT = 116;
/** Columns left of every body line for the selection bar. */
export const GUTTER = 2;

/**
 * Room around the overlay. None: the board covers the whole terminal like a fullscreen app, so no
 * transcript text peeks out around its edges.
 */
export function boardMargin(
	_columns: number,
	_rows: number,
): { top: number; bottom: number; left: number; right: number } {
	return { top: 0, bottom: 0, left: 0, right: 0 };
}

/** Overlay options for a board on a terminal of this size: as large as the terminal. */
export function boardOverlay(columns: number, rows: number): OverlayOptions {
	return { anchor: "center", width: "100%", maxHeight: "100%", margin: boardMargin(columns, rows) };
}

/** How much of a tab label shows: everything, the count, a short name, or the number key only. */
type LabelStyle = "full" | "count" | "short" | "tiny" | "number";

function tabLabel(
	tab: BoardTab,
	index: number,
	summary: TabSummary,
	style: LabelStyle,
	active: boolean,
	comments: number,
): Line {
	if (style === "number") return [sp(String(index + 1), active ? "accent" : summary.reached ? "text" : "dim", active)];
	const dim = !summary.reached && !active;
	const name: Color = active ? "accent" : dim ? "dim" : "text";
	const line: Line = [];
	const rich = style === "full" || style === "count";
	if (rich && summary.current)
		line.push(sp(summary.current === "review" ? "◉ " : "● ", summary.current === "review" ? "warning" : "accent"));
	line.push(sp(rich ? TAB_NAME[tab] : TAB_SHORT[tab], name, active));
	if (style !== "tiny" && summary.count) line.push(sp(` ${summary.count}`, active ? "accent" : dim ? "dim" : "muted"));
	if (style === "full" && summary.extra) line.push(sp(" "), dim ? { ...summary.extra, color: "dim" } : summary.extra);
	if (rich && comments) line.push(sp(` ✎${comments}`, "warning"));
	return line;
}

export interface TabRange {
	tab: BoardTab;
	/** First and one past the last column of the label, in the line. */
	start: number;
	end: number;
}

/** Label styles to try, widest first: the active tab's style, the other tabs' style and the gap. */
const PLANS: [LabelStyle, LabelStyle, number][] = [
	["full", "full", 3],
	["full", "full", 2],
	["full", "count", 2],
	["count", "count", 2],
	["count", "short", 2],
	["short", "short", 2],
	["short", "tiny", 1],
	["short", "number", 1],
	["tiny", "number", 1],
	["number", "number", 1],
];

/**
 * The tab bar: `Brief   Explore 7   ● Decisions 3 (1 open)   Diagrams 2 …`. At narrow widths the labels
 * lose their notes, then their counts, then shorten to `Brf Exp Dec`, then to the number keys.
 */
export function tabBar(
	summaries: Record<BoardTab, TabSummary>,
	active: BoardTab,
	comments: Partial<Record<BoardTab, number>>,
	width: number,
): { line: Line; ranges: TabRange[] } {
	let best: { line: Line; ranges: TabRange[] } | undefined;
	for (const [mine, others, gap] of PLANS) {
		const line: Line = [];
		const ranges: TabRange[] = [];
		let at = 0;
		TABS.forEach((tab, i) => {
			if (i) {
				line.push(sp(" ".repeat(gap)));
				at += gap;
			}
			const label = tabLabel(
				tab,
				i,
				summaries[tab],
				tab === active ? mine : others,
				tab === active,
				comments[tab] ?? 0,
			);
			const w = lineWidth(label);
			ranges.push({ tab, start: at, end: at + w });
			line.push(...label);
			at += w;
		});
		best = { line, ranges };
		if (at <= width) return best;
	}
	return { line: clipLine(best!.line, width), ranges: best!.ranges.filter((r) => r.end <= width) };
}

/** `├────━━━━━━━━──────┤`: the rule under the tab bar, heavy and in accent under the active tab. */
export function tabRule(total: number, offset: number, range: TabRange | undefined): Line {
	const inner = Math.max(0, total - 2);
	if (!range) return [sp(`├${"─".repeat(inner)}┤`, "border")];
	// Inner column i is terminal column i + 1. The heavy part reaches one column past each end of the label.
	const start = Math.min(inner, Math.max(0, offset + range.start - 2));
	const end = Math.min(inner, Math.max(start, offset + range.end));
	return [
		sp(`├${"─".repeat(start)}`, "border"),
		sp("━".repeat(end - start), "accent"),
		sp(`${"─".repeat(inner - end)}┤`, "border"),
	];
}

/** A tab's empty state, centered: what will appear there and when. */
export function emptyLines(empty: EmptyState, width: number): Line[] {
	const center = (line: Line): Line => {
		const pad = Math.max(0, Math.floor((width - lineWidth(line)) / 2));
		return [sp(" ".repeat(pad)), ...clipLine(line, width)];
	};
	const text = wrap(empty.text, Math.min(width, 64));
	// The paragraph is centered as a block, so its lines stay left-aligned with each other.
	const block = Math.max(...text.map((l) => lineWidth([sp(l)])));
	const left = sp(" ".repeat(Math.max(0, Math.floor((width - block) / 2))));
	return [
		[],
		center([sp("○  ", "dim"), sp(empty.title, "muted", true)]),
		...(empty.note ? wrap(empty.note, Math.min(width, 64)).map((l) => center([sp(l, "dim")])) : []),
		[],
		...text.map((l) => [left, sp(l, "muted")]),
	];
}

export type HintPair = readonly [string, string];

/** The first set of key hints that fits on one line, else the last one packed into at most `max` lines. */
export function hintRows(sets: readonly (readonly HintPair[])[], width: number, max: number): Line[] {
	for (const set of sets) if (lineWidth(hints(set)) <= width) return [hints(set)];
	return hintLines(sets.at(-1) ?? [], width).slice(0, Math.max(1, max));
}

/** `↑ 4 · ↓ 12 more`, or nothing when everything is in view. */
export function scrollLabel(scroll: number, viewport: number, total: number): Line {
	const below = total - viewport - scroll;
	const parts: Span[] = [];
	if (scroll > 0) parts.push(sp(`↑ ${scroll}`, "dim"));
	if (scroll > 0 && below > 0) parts.push(sp(" · ", "dim"));
	if (below > 0) parts.push(sp(`↓ ${below} more`, "dim"));
	return parts;
}

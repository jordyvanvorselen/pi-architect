import type { Decision, DecisionOption } from "../../state/types.ts";
import { meter } from "../meter.ts";
import {
	box,
	clipLine,
	columns,
	hintLines,
	hints,
	innerWidth,
	lineWidth,
	padBlock,
	sp,
	wrap,
	wrapAfter,
	type Line,
} from "../spans.ts";

/** What the user is doing on the card: looking at the options, or writing in the inline editor. */
export type DecisionMode = "browse" | "comment" | "own" | "ask";

export interface DecisionView {
	decision: Decision;
	/** Index of the focused option. */
	focus: number;
	mode: DecisionMode;
	/** 1-based position of this decision, for "Decision 3/5". */
	index?: number;
	total?: number;
	feature?: string;
	/** The inline editor's lines at a width, while `mode` is not `browse`. */
	editor?: (width: number) => Line[];
	/** Rows the card may use. A taller side-by-side layout folds into a list. */
	maxRows?: number;
}

/** Narrowest option card, borders included. Narrower and the options fold into a list. */
export const MIN_CARD = 22;
/** Widest option card. Wider cards only spread short lines thin. */
export const MAX_CARD = 40;
const GAP = 2;
/** The card never gets narrower than this, so short questions still read as a dialog. */
const MIN_FRAME = 72;

/** How the options are laid out: all in a row, two by two, or a list with the focused one open. */
export type CardLayout = { kind: "row" | "grid"; columns: number } | { kind: "list" };

/** The widest layout whose cards are at least `MIN_CARD` wide in `inner` columns. */
export function chooseLayout(count: number, inner: number): CardLayout {
	const fits = (cols: number) => Math.floor((inner - GAP * (cols - 1)) / cols) >= MIN_CARD;
	if (fits(count)) return { kind: "row", columns: count };
	if (count === 4 && fits(2)) return { kind: "grid", columns: 2 };
	return { kind: "list" };
}

/** Split `total` columns into `count` widths that differ by at most one. */
export function split(total: number, count: number): number[] {
	const base = Math.floor(total / count);
	const rest = total - base * count;
	return Array.from({ length: count }, (_, i) => base + (i < rest ? 1 : 0));
}

function titleLine(option: DecisionOption, recommended: boolean, focused: boolean): Line {
	return [
		sp(option.id, "accent", true),
		sp("  "),
		sp(option.title, focused ? "text" : "muted", focused),
		...(recommended ? [sp(" ★", "warning")] : []),
	];
}

function ratings(option: DecisionOption): Line[] {
	if (option.byUser) return [[sp("your own option", "dim")]];
	return [
		[sp("effort ", "dim"), ...meter(option.effort)],
		[sp("risk   ", "dim"), ...meter(option.risk)],
	];
}

interface CardParts {
	/** Title (when not in the border) and summary. */
	head: Line[];
	/** Effort, risk, pros and cons. */
	rest: Line[];
}

/** The inside of one option card, in two parts so cards in a row can line up their meters. */
function cardParts(option: DecisionOption, inner: number, titleInBorder: boolean, recommended: boolean): CardParts {
	const head: Line[] = [];
	if (!titleInBorder) {
		head.push(...wrap(option.title, inner).map((l) => [sp(l, "text", true)]));
		if (recommended) head.push([sp("★ recommended", "warning")]);
	}
	if (option.summary) head.push(...wrap(option.summary, inner).map((l) => [sp(l, "muted")]));
	const rest = ratings(option);
	for (const pro of option.pros) rest.push(...wrapAfter([sp("+ ", "success")], pro, inner, "text"));
	for (const con of option.cons) rest.push(...wrapAfter([sp("− ", "warning")], con, inner, "text"));
	return { head, rest };
}

/** Head, a blank line when any card in the row has a head, then the rest. */
const stack = (parts: CardParts, headHeight: number): Line[] =>
	headHeight ? [...padBlock(parts.head, headHeight), [], ...parts.rest] : parts.rest;

const cardInner = (width: number) => innerWidth(width);

/** True when every title fits in its card's top border. */
function titlesFit(decision: Decision, width: number): boolean {
	return decision.options.every((o) => lineWidth(titleLine(o, o.id === decision.recommendation, true)) + 6 <= width);
}

/** Option cards in rows of `perRow`, each row as tall as its tallest card. */
function cardRows(view: DecisionView, inner: number, perRow: number): Line[] {
	const { decision } = view;
	const widths = split(inner - GAP * (perRow - 1), perRow).map((w) => Math.min(w, MAX_CARD));
	const inBorder = titlesFit(decision, Math.min(...widths));
	const lines: Line[] = [];
	for (let start = 0; start < decision.options.length; start += perRow) {
		const row = decision.options.slice(start, start + perRow);
		const parts = row.map((o, i) => cardParts(o, cardInner(widths[i]!), inBorder, o.id === decision.recommendation));
		const headHeight = Math.max(...parts.map((p) => p.head.length));
		const bodies = parts.map((p) => stack(p, headHeight));
		const height = Math.max(...bodies.map((b) => b.length));
		const cards = row.map((o, i) => {
			const focused = start + i === view.focus;
			const recommended = o.id === decision.recommendation;
			return box(padBlock(bodies[i]!, height), widths[i]!, {
				style: focused ? "heavy" : "light",
				color: focused ? "borderAccent" : "borderMuted",
				title: inBorder ? titleLine(o, recommended, focused) : [sp(o.id, "accent", true)],
			});
		});
		if (start > 0) lines.push([]);
		lines.push(...columns(cards, widths.slice(0, row.length), GAP));
	}
	return lines;
}

/** One folded option: `B  In backend ★        effort ▰▰▰▱▱  risk ▰▰▱▱▱`. */
function foldedRow(option: DecisionOption, recommended: boolean, inner: number): Line {
	const left: Line = [sp("  "), ...titleLine(option, recommended, false)];
	const rights: Line[] = option.byUser
		? [[sp("your own", "dim")]]
		: [
				[sp("effort ", "dim"), ...meter(option.effort), sp("  risk ", "dim"), ...meter(option.risk)],
				[sp("e ", "dim"), ...meter(option.effort), sp(" r ", "dim"), ...meter(option.risk)],
			];
	for (const right of rights) {
		const space = inner - lineWidth(left) - lineWidth(right);
		if (space >= 2) return [...left, sp(" ".repeat(space)), ...right];
	}
	return clipLine(left, inner);
}

/** The focused option as an open card, the others as one line each. */
function listRows(view: DecisionView, inner: number): Line[] {
	const { decision } = view;
	const lines: Line[] = [];
	decision.options.forEach((o, i) => {
		const recommended = o.id === decision.recommendation;
		if (i !== view.focus) {
			lines.push(foldedRow(o, recommended, inner));
			return;
		}
		const inBorder = lineWidth(titleLine(o, recommended, true)) + 6 <= inner;
		const parts = cardParts(o, cardInner(inner), inBorder, recommended);
		lines.push(
			...box(stack(parts, parts.head.length), inner, {
				style: "heavy",
				color: "borderAccent",
				title: inBorder ? titleLine(o, recommended, true) : [sp(o.id, "accent", true)],
			}),
		);
	});
	return lines;
}

const EDIT_LABEL: Record<Exclude<DecisionMode, "browse">, string> = {
	comment: "Your comment",
	own: "Your own option",
	ask: "Your question for the agent",
};

function browseHints(inner: number, move: string): Line[] {
	const wide = [
		["↵", "choose"],
		["c", "choose with comment"],
		["n", "own option"],
		["?", "ask"],
		[move, "move"],
		["esc", "close"],
	] as const;
	if (lineWidth(hints(wide)) <= inner) return [hints(wide)];
	return hintLines(
		[
			["↵", "choose"],
			["c", "comment"],
			["n", "own"],
			["?", "ask"],
			[move, "move"],
			["esc", "close"],
		],
		inner,
	);
}

export const editHints = (inner: number): Line[] =>
	hintLines(
		[
			["↵", "send"],
			["shift+↵", "new line"],
			["esc", "back"],
		],
		inner,
	);

/** The width the card uses: the terminal width, or less when the options do not need it. */
export function frameWidth(count: number, total: number): number {
	const needed = count * MAX_CARD + GAP * (count - 1) + 6;
	return Math.min(total, Math.max(MIN_FRAME, needed));
}

function header(view: DecisionView): { title: Line; right: Line } {
	const position = view.index ? ` ${view.index}${view.total ? `/${Math.max(view.total, view.index)}` : ""}` : "";
	return {
		title: [sp("◆", "accent", true), sp(` Decision${position}`, "accent", true)],
		right: view.feature ? [sp(view.feature, "dim")] : [],
	};
}

function body(view: DecisionView, inner: number, layout: CardLayout): Line[] {
	const { decision } = view;
	const lines: Line[] = [];
	lines.push(...wrap(decision.question, inner).map((l) => [sp(l, "text", true)]));
	if (decision.context) lines.push(...wrap(decision.context, inner).map((l) => [sp(l, "muted")]));
	lines.push([]);
	lines.push(...(layout.kind === "list" ? listRows(view, inner) : cardRows(view, inner, layout.columns)));

	const recommended = decision.options.find((o) => o.id === decision.recommendation);
	if (recommended) {
		lines.push([]);
		const full: Line = [
			sp("★ ", "warning"),
			sp("Agent recommends ", "dim"),
			sp(recommended.id, "accent", true),
			sp("  "),
		];
		const short: Line = [sp("★ ", "warning"), sp(recommended.id, "accent", true), sp("  ")];
		lines.push(...wrapAfter(inner - lineWidth(full) >= 12 ? full : short, recommended.title, inner, "text"));
		if (decision.reason) lines.push(...wrapAfter([sp("  ")], decision.reason, inner, "muted"));
	}

	if (view.mode !== "browse") {
		const focused = decision.options[view.focus];
		const label: Line =
			view.mode === "comment" && focused
				? [sp(`${EDIT_LABEL.comment} on `, "accent"), sp(focused.id, "accent", true), sp(` ${focused.title}`, "accent")]
				: [sp(EDIT_LABEL[view.mode], "accent")];
		lines.push([], clipLine(label, inner), ...(view.editor?.(inner) ?? []));
		lines.push(...editHints(inner));
	} else {
		lines.push([], ...browseHints(inner, layout.kind === "list" ? "↑↓" : "←→"));
	}
	return lines;
}

/**
 * The decision card as lines of spans, at most `total` columns wide:
 * the question, the options as cards (side by side when they fit, else folded into a list), the
 * recommendation, the inline editor when the user is writing, and the key hints.
 */
export function renderDecision(view: DecisionView, total: number): Line[] {
	const width = frameWidth(view.decision.options.length, total);
	const padX = width >= 60 ? 2 : 1;
	const inner = innerWidth(width, padX);
	const { title, right } = header(view);
	const frame = (layout: CardLayout) =>
		box([[], ...body(view, inner, layout)], width, { style: "round", color: "border", title, right, padX });
	const layout = chooseLayout(view.decision.options.length, inner);
	const lines = frame(layout);
	if (layout.kind !== "list" && view.maxRows !== undefined && lines.length > view.maxRows)
		return frame({ kind: "list" });
	return lines;
}

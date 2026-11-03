import { PHASE_LABEL, PHASES, phaseIndex, type Phase } from "../../state/phases.ts";
import { boxRow, edge, hintLines, innerWidth, rule, sp, wrap, type Line, type Span } from "../spans.ts";

/** `browse`: reading and scrolling. `changes`: writing what should change in the inline editor. */
export type ReviewMode = "browse" | "changes";

export interface ReviewView {
	phase: Phase;
	feature?: string;
	/** What the agent asked the user to check. */
	summary?: string;
	/** The phase body at the inner width. */
	body: Line[];
	/** First body line in view. Clamped to the body. */
	scroll: number;
	mode: ReviewMode;
	/** The inline editor's lines at a width, in `changes` mode. */
	editor?: (width: number) => Line[];
	/** Rows the screen may use. Longer bodies scroll. */
	maxRows?: number;
}

export interface ReviewLayout {
	lines: Line[];
	/** Body lines in view, the clamped scroll position and the furthest it can go. */
	viewport: number;
	scroll: number;
	maxScroll: number;
}

/** The review screen never gets wider than this, so text lines stay readable. */
export const MAX_REVIEW_WIDTH = 120;
/** Body rows the screen keeps in view even on a short terminal. */
const MIN_VIEWPORT = 3;

/** Frame width, side padding and content width of the screen at `total` columns. */
export function reviewGeometry(total: number): { width: number; padX: number; inner: number } {
	const width = Math.min(total, MAX_REVIEW_WIDTH);
	const padX = width >= 60 ? 2 : 1;
	return { width, padX, inner: innerWidth(width, padX) };
}

function footer(view: ReviewView, inner: number, scrollable: boolean): Line[] {
	const label = PHASE_LABEL[view.phase];
	if (view.mode === "changes")
		return [
			[sp(`What should change in ${label}?`, "accent", true)],
			...(view.editor?.(inner) ?? []),
			...hintLines(
				[
					["↵", "send"],
					["shift+↵", "new line"],
					["esc", "back"],
				],
				inner,
			),
		];
	return hintLines(
		[
			["↵", `approve ${label}`],
			["r", "request changes"],
			...(scrollable ? ([["↑↓", "scroll"]] as const) : []),
			["esc", "close"],
		],
		inner,
	);
}

/** `↑ 4 · ↓ 12 more`, or nothing when the whole body is in view. */
function scrollLabel(scroll: number, viewport: number, total: number): Line {
	const above = scroll;
	const below = total - viewport - scroll;
	const parts: Span[] = [];
	if (above > 0) parts.push(sp(`↑ ${above}`, "dim"));
	if (above > 0 && below > 0) parts.push(sp(" · ", "dim"));
	if (below > 0) parts.push(sp(`↓ ${below} more`, "dim"));
	return parts;
}

/**
 * The Phase Review screen as lines of spans: a titled frame with the agent's summary, the phase body in a
 * scrolling viewport with a scrollbar on the right edge, and the verdict actions at the bottom.
 */
export function renderReview(view: ReviewView, total: number): ReviewLayout {
	const { width, padX, inner } = reviewGeometry(total);
	const row = (line: Line, side?: Span) => boxRow(line, width, "round", "border", padX, side);
	const title: Line = [
		sp("◆", "accent", true),
		sp(" Review ", "accent", true),
		sp(PHASE_LABEL[view.phase], "text", true),
		sp(` ${phaseIndex(view.phase) + 1}/${PHASES.length}`, "dim"),
	];
	const head: Line[] = [edge(width, "round", "border", "top", title, view.feature ? [sp(view.feature, "dim")] : [])];
	if (view.summary) {
		head.push(row([]));
		for (const line of wrap(view.summary, inner - 2)) head.push(row([sp("▍ ", "accent"), sp(line, "muted")]));
		head.push(rule(width, "border"));
	}
	const body = [[], ...view.body, []];
	const foot = (scrollable: boolean) => footer(view, inner, scrollable);
	const chrome = (scrollable: boolean) => head.length + 1 + foot(scrollable).length + 1;
	let viewport = body.length;
	if (view.maxRows !== undefined && body.length + chrome(false) > view.maxRows)
		viewport = Math.min(body.length, Math.max(MIN_VIEWPORT, view.maxRows - chrome(true)));
	const scrollable = viewport < body.length;
	const maxScroll = body.length - viewport;
	const scroll = Math.min(Math.max(0, view.scroll), maxScroll);

	const thumb = Math.max(1, Math.round((viewport * viewport) / body.length));
	const thumbAt = maxScroll ? Math.round((scroll / maxScroll) * (viewport - thumb)) : 0;
	const side = (i: number): Span | undefined =>
		scrollable ? (i >= thumbAt && i < thumbAt + thumb ? sp("┃", "accent") : sp("│", "borderMuted")) : undefined;

	const lines: Line[] = [
		...head,
		...body.slice(scroll, scroll + viewport).map((line, i) => row(line, side(i))),
		rule(width, "border"),
		...foot(scrollable).map((line) => row(line)),
		edge(width, "round", "border", "bottom", [], scrollLabel(scroll, viewport, body.length)),
	];
	return { lines, viewport, scroll, maxScroll };
}

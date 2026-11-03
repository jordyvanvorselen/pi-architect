import type { ReviewRequest } from "../../review.ts";
import type { Architecture, Risk, Severity } from "../../state/types.ts";
import type { Color, Paint } from "../paint.ts";
import { columns, lineWidth, sp, wrap, wrapAfter, type Line } from "../spans.ts";

/**
 * The body of one Phase Review screen: what the agent produced, as lines of spans at most `width` wide.
 * The screen frames it, scrolls it and adds the verdict actions. `paint` is for content that comes styled
 * already, like diagrams: put it in `raw` spans.
 */
export type ReviewBody = (arch: Architecture, width: number, paint: Paint, request: ReviewRequest) => Line[];

/** `GOAL`, with an optional note pushed to the right edge. */
export function heading(text: string, width: number, right: Line = []): Line {
	const left = [sp(text.toUpperCase(), "accent", true)];
	const space = width - lineWidth(left) - lineWidth(right);
	return right.length && space >= 2 ? [...left, sp(" ".repeat(space)), ...right] : left;
}

/** A section: heading, its lines, and a blank line before the next section. */
export function section(title: string, lines: readonly Line[], width: number, right: Line = []): Line[] {
	return [heading(title, width, right), ...lines, []];
}

/** `• item` per item, wrapped under the text. `none` when empty. */
export function bullets(
	items: readonly string[],
	width: number,
	marker = "•",
	markerColor: Color = "dim",
	color: Color = "text",
): Line[] {
	if (!items.length) return [[sp("none", "dim")]];
	return items.flatMap((item) => wrapAfter([sp(`${marker} `, markerColor)], item, width, color));
}

/** Text wrapped under a fixed indent, e.g. tree lines. Wraps without it when it leaves too little room. */
export function wrapIndented(text: string, indent: string, width: number, color: Color): Line[] {
	const room = width - lineWidth([sp(indent)]);
	if (room < 8) return wrap(text, width).map((l) => [sp(l, color)]);
	return wrap(text, room).map((l) => [sp(indent, "borderMuted"), sp(l, color)]);
}

/** Wrapped text in one colour. */
export const paragraph = (text: string, width: number, color: Color = "text", bold = false): Line[] =>
	wrap(text, width).map((l) => [sp(l, color, bold)]);

/** Narrowest width that shows two blocks side by side. */
export const PAIR_MIN = 60;
const PAIR_GAP = 3;

/** The widths of the two blocks `pair` lays out: halves when side by side, else the full width each. */
export function halves(width: number): [number, number] {
	if (width < PAIR_MIN) return [width, width];
	const half = Math.floor((width - PAIR_GAP) / 2);
	return [half, width - PAIR_GAP - half];
}

/** Two blocks side by side when there is room, else one under the other. */
export function pair(left: Line[], right: Line[], width: number): Line[] {
	if (width < PAIR_MIN) return [...left, [], ...right];
	return columns([left, right], halves(width), PAIR_GAP);
}

export const SEVERITY_COLOR: Record<Severity, Color> = { high: "error", medium: "warning", low: "muted" };

function riskLines(risk: Risk, width: number): Line[] {
	const tag = risk.severity.padEnd(7);
	const lines = wrapAfter(
		[sp("⚠ ", SEVERITY_COLOR[risk.severity]), sp(tag, SEVERITY_COLOR[risk.severity])],
		risk.text,
		width,
		"text",
	);
	if (risk.mitigation)
		lines.push(...wrapAfter([sp("  "), sp(" ".repeat(tag.length)), sp("↳ ", "dim")], risk.mitigation, width, "muted"));
	return lines;
}

/** Every risk, high first. Empty when there are none. */
export function risks(arch: Architecture, width: number): Line[] {
	if (!arch.risks.length) return [];
	const order: Severity[] = ["high", "medium", "low"];
	const sorted = [...arch.risks].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
	const count = arch.risks.length;
	return section(
		"Risks",
		sorted.flatMap((r) => riskLines(r, width)),
		width,
		[sp(`${count} risk${count === 1 ? "" : "s"}`, "dim")],
	);
}

/** Drop the blank line that ends the last section. */
export function trim(lines: Line[]): Line[] {
	while (lines.length && lines.at(-1)!.length === 0) lines.pop();
	return lines;
}

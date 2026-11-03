import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Theme colors this extension uses. Pi's `Theme` fits this shape. */
export type Color =
	| "accent"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "border"
	| "borderMuted"
	| "borderAccent"
	| "toolTitle"
	| "toolOutput";

export interface Paint {
	fg(color: Color, text: string): string;
	bold(text: string): string;
}

/**
 * A piece of a line, kept both plain and styled. Layout decisions measure the plain text, so they do
 * not depend on how the theme styles it, and tests with a tagging theme lay out like the real one.
 */
export interface Seg {
	plain: string;
	styled: string;
}

export const seg = (plain: string, styled = plain): Seg => ({ plain, styled });

export function paintSeg(paint: Paint, color: Color, text: string, bold = false): Seg {
	return seg(text, paint.fg(color, bold ? paint.bold(text) : text));
}

export function join(parts: readonly Seg[], separator: Seg = seg("")): Seg {
	return {
		plain: parts.map((p) => p.plain).join(separator.plain),
		styled: parts.map((p) => p.styled).join(separator.styled),
	};
}

export const width = (s: Seg): number => visibleWidth(s.plain);

/** `left` and `right` on one line, `right` pushed to the right edge. Undefined when they do not fit with a gap. */
export function spread(left: Seg, right: Seg, total: number, gap = 2): string | undefined {
	const space = total - width(left) - width(right);
	if (space < gap) return undefined;
	return `${left.styled}${" ".repeat(space)}${right.styled}`;
}

/** The first candidate that fits, or the last one cut to the width. */
export function firstFit(candidates: readonly Seg[], total: number): string {
	for (const candidate of candidates) if (width(candidate) <= total) return candidate.styled;
	const last = candidates.at(-1);
	return last ? truncateToWidth(last.styled, total, "…") : "";
}

/** Cut plain text to `max` columns with an ellipsis. */
export function clip(text: string, max: number): string {
	return visibleWidth(text) <= max ? text : stripTerminalSequences(truncateToWidth(text, max, "…"));
}

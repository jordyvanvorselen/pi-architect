import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { clip, type Color, type Paint } from "./paint.ts";

/**
 * A run of text with one style. Screens lay out lines of spans on plain text, then paint them at the end,
 * so a layout never depends on how the theme styles it and a theme change only needs a new paint.
 * `raw` holds text that is styled already, e.g. an `Editor` line; `text` is then its plain form, for measuring.
 */
export interface Span {
	text: string;
	color?: Color;
	bold?: boolean;
	raw?: string;
}

export type Line = Span[];

export const sp = (text: string, color?: Color, bold = false): Span => ({
	text,
	...(color ? { color } : {}),
	...(bold ? { bold } : {}),
});

/** A span that is styled already. `plain` must have the same width. */
export const raw = (styled: string, plain: string): Span => ({ text: plain, raw: styled });

export const lineWidth = (line: Line): number => line.reduce((n, s) => n + visibleWidth(s.text), 0);

/** Cut a line to `max` columns, with an ellipsis where it was cut. */
export function clipLine(line: Line, max: number): Line {
	if (lineWidth(line) <= max) return line;
	const out: Line = [];
	let used = 0;
	for (const s of line) {
		const w = visibleWidth(s.text);
		if (used + w <= max - 1) {
			out.push(s);
			used += w;
			continue;
		}
		const room = max - used;
		if (room > 0) {
			const text = clip(s.text, room);
			out.push(s.raw !== undefined ? raw(truncateToWidth(s.raw, room, "…"), text) : { ...s, text });
		}
		break;
	}
	return out;
}

/** Cut or pad a line to exactly `total` columns. */
export function fitLine(line: Line, total: number): Line {
	const cut = clipLine(line, total);
	const rest = total - lineWidth(cut);
	return rest > 0 ? [...cut, sp(" ".repeat(rest))] : cut;
}

export function paintSpan(s: Span, paint: Paint): string {
	if (s.raw !== undefined) return s.raw;
	if (!s.text) return "";
	const text = s.bold ? paint.bold(s.text) : s.text;
	return s.color ? paint.fg(s.color, text) : text;
}

export const paintLine = (line: Line, paint: Paint): string => line.map((s) => paintSpan(s, paint)).join("");

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Break one word that is wider than `max` into pieces that fit, after a `/` where there is one. */
function breakWord(word: string, max: number): string[] {
	const pieces: string[] = [];
	let piece = "";
	for (const { segment } of segmenter.segment(word)) {
		if (piece && visibleWidth(piece + segment) > max) {
			const slash = piece.lastIndexOf("/") + 1;
			if (slash > 0 && slash < piece.length) {
				pieces.push(piece.slice(0, slash));
				piece = piece.slice(slash);
			} else {
				pieces.push(piece);
				piece = "";
			}
		}
		piece += segment;
	}
	if (piece) pieces.push(piece);
	return pieces;
}

/** `text` cut to `max` columns in the middle, with `…`, so both ends of a path stay readable. */
export function middleTruncate(text: string, max: number): string {
	if (visibleWidth(text) <= max) return text;
	if (max <= 1) return "…".slice(0, Math.max(0, max));
	const chars = [...segmenter.segment(text)].map((s) => s.segment);
	const keep = max - 1;
	const head = Math.ceil(keep / 2);
	return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - (keep - head)).join("")}`;
}

/**
 * `prefix` then a file path, on one line when it fits. Otherwise the path goes on its own lines, indented
 * by `indent`, broken after a `/`; a single part that is too long is cut in the middle with `…`.
 */
export function pathAfter(prefix: Line, path: string, total: number, color?: Color, indent = 2): Line[] {
	if (lineWidth(prefix) + visibleWidth(path) <= total) return [[...prefix, sp(path, color)]];
	const room = Math.max(1, total - indent);
	const pad = sp(" ".repeat(Math.min(indent, total - 1)));
	const lines: Line[] = [clipLine(prefix, total)];
	let line = "";
	for (const part of path.split(/(?<=\/)/)) {
		if (line && visibleWidth(line + part) > room) {
			lines.push([pad, sp(line, color)]);
			line = "";
		}
		line += part;
		if (visibleWidth(line) > room) {
			lines.push([pad, sp(middleTruncate(line, room), color)]);
			line = "";
		}
	}
	if (line) lines.push([pad, sp(line, color)]);
	return lines;
}

/** Word-wrap plain text to `max` columns. Keeps line breaks; breaks words that do not fit on their own. */
export function wrap(text: string, max: number): string[] {
	const width = Math.max(1, max);
	const out: string[] = [];
	for (const paragraph of text.split("\n")) {
		let line = "";
		for (const word of paragraph.split(/\s+/).filter(Boolean)) {
			const candidate = line ? `${line} ${word}` : word;
			if (visibleWidth(candidate) <= width) {
				line = candidate;
				continue;
			}
			if (line) out.push(line);
			const pieces = visibleWidth(word) > width ? breakWord(word, width) : [word];
			line = pieces.pop()!;
			out.push(...pieces);
		}
		out.push(line);
	}
	return out;
}

/**
 * `prefix` then `text` wrapped to `total` columns, continuation lines indented under the text.
 * When the prefix leaves too little room, the text wraps under the prefix instead.
 */
export function wrapAfter(prefix: Line, text: string, total: number, color?: Color, bold = false): Line[] {
	const indent = lineWidth(prefix);
	const room = total - indent;
	if (room < 8) return [clipLine(prefix, total), ...wrap(text, total).map((l) => [sp(l, color, bold)])];
	return wrap(text, room).map((l, i) => [i === 0 ? prefix : [sp(" ".repeat(indent))], [sp(l, color, bold)]].flat());
}

export type BorderStyle = "round" | "light" | "heavy";

const BOX: Record<BorderStyle, { tl: string; tr: string; bl: string; br: string; h: string; v: string }> = {
	round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
	light: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
	heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
};

export const vertical = (style: BorderStyle) => BOX[style].v;

/**
 * `╭─ left ───── right ─╮` (or the bottom edge). Labels get a space on each side and are dropped,
 * right first, when they do not fit.
 */
export function edge(
	total: number,
	style: BorderStyle,
	color: Color,
	where: "top" | "bottom",
	left: Line = [],
	right: Line = [],
): Line {
	const box = BOX[style];
	const [start, end] = where === "top" ? [box.tl, box.tr] : [box.bl, box.br];
	if (total < 2) return [sp(start.slice(0, total), color)];
	const inner = total - 2;
	const label = (l: Line): Line => (l.length ? [sp(" "), ...l, sp(" ")] : []);
	let l = label(left);
	let r = label(right);
	if (lineWidth(l) + lineWidth(r) + 2 > inner) r = [];
	if (lineWidth(l) + 2 > inner) l = inner > 4 ? label(clipLine(left, inner - 4)) : [];
	const lead = l.length ? 1 : 0;
	const tail = r.length ? 1 : 0;
	const fill = inner - lead - tail - lineWidth(l) - lineWidth(r);
	return [
		sp(start + box.h.repeat(lead), color),
		...l,
		sp(box.h.repeat(Math.max(0, fill)), color),
		...r,
		sp(box.h.repeat(tail) + end, color),
	];
}

/** `├──────┤`, a rule across a frame. */
export function rule(total: number, color: Color): Line {
	return [sp(`├${"─".repeat(Math.max(0, total - 2))}┤`, color)];
}

export interface BoxOptions {
	style: BorderStyle;
	color: Color;
	title?: Line;
	right?: Line;
	bottom?: Line;
	/** Spaces between the side border and the content. Default 1. */
	padX?: number;
}

/** Content width inside a box of `total` columns. */
export const innerWidth = (total: number, padX = 1) => Math.max(0, total - 2 - 2 * padX);

/** One content row of a box: `\u2502 line \u2502`, the line cut or padded to the inner width. */
export function boxRow(line: Line, total: number, style: BorderStyle, color: Color, padX = 1, side?: Span): Line {
	const v = BOX[style].v;
	const pad = sp(" ".repeat(padX));
	return [sp(v, color), pad, ...fitLine(line, innerWidth(total, padX)), pad, side ?? sp(v, color)];
}

/** Draw `body` in a box `total` columns wide. Body lines are cut or padded to the inner width. */
export function box(body: readonly Line[], total: number, options: BoxOptions): Line[] {
	const { style, color } = options;
	const padX = options.padX ?? 1;
	return [
		edge(total, style, color, "top", options.title, options.right),
		...body.map((line) => boxRow(line, total, style, color, padX)),
		edge(total, style, color, "bottom", [], options.bottom),
	];
}

/** Blocks side by side, each padded to its width, `gap` columns apart. Shorter blocks get blank rows. */
export function columns(blocks: readonly (readonly Line[])[], widths: readonly number[], gap: number): Line[] {
	const height = Math.max(0, ...blocks.map((b) => b.length));
	const rows: Line[] = [];
	for (let r = 0; r < height; r++) {
		const row: Line = [];
		blocks.forEach((block, i) => {
			if (i > 0) row.push(sp(" ".repeat(gap)));
			row.push(...fitLine(block[r] ?? [], widths[i]!));
		});
		rows.push(row);
	}
	return rows;
}

/** Pad a block with blank lines to `height` rows. */
export const padBlock = (block: readonly Line[], height: number): Line[] => [
	...block,
	...Array.from({ length: Math.max(0, height - block.length) }, () => [] as Line),
];

/** `key label` pairs, the keys brighter than their labels. */
export function hints(pairs: readonly (readonly [string, string])[]): Line {
	const line: Line = [];
	pairs.forEach(([key, label], i) => {
		if (i > 0) line.push(sp("  "));
		line.push(sp(key, "muted"));
		if (label) line.push(sp(` ${label}`, "dim"));
	});
	return line;
}

/**
 * A question with its answer keys, `Close without a verdict? The agent will stop.  ↵ close  esc back`, on one
 * line when it fits, else the question wrapped above the keys.
 */
export function confirmLines(question: string, pairs: readonly (readonly [string, string])[], inner: number): Line[] {
	const keys = hints(pairs);
	const ask = sp(question, "warning", true);
	if (lineWidth([ask]) + 2 + lineWidth(keys) <= inner) return [[ask, sp("  "), ...keys]];
	return [...wrap(question, inner).map((l) => [sp(l, "warning", true)]), clipLine(keys, inner)];
}

/** Pack key hints into as few lines as fit. */
export function hintLines(pairs: readonly (readonly [string, string])[], inner: number): Line[] {
	const lines: Line[] = [];
	let current: (readonly [string, string])[] = [];
	for (const pair of pairs) {
		const next = [...current, pair];
		if (current.length && lineWidth(hints(next)) > inner) {
			lines.push(hints(current));
			current = [pair];
		} else current = next;
	}
	if (current.length) lines.push(clipLine(hints(current), inner));
	return lines;
}

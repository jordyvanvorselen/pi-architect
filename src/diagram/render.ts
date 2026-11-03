// Shows a model-drawn diagram: a titled card around the drawing, lines and arrows in quiet colours, and parts
// marked [new], [changed] or [removed] coloured with their box. The drawing itself is never reflowed.
import { visibleWidth } from "@earendil-works/pi-tui";
import { findBoxes, Grid, isArrow, isBlank, isLine, WIDE_TAIL } from "./grid.ts";
import { findMarkers, type Status, STATUSES } from "./markers.ts";
import { clean, truncate, wrap } from "./text.ts";
import type { Diagram, DiagramColor, DiagramTheme } from "./types.ts";
import { normalizeBody } from "./validate.ts";

export interface Style {
	color?: DiagramColor | undefined;
	bold?: boolean | undefined;
	strike?: boolean | undefined;
}

export const STATUS_COLOR: Record<Status, DiagramColor> = { new: "success", changed: "warning", removed: "error" };
const LINE: Style = { color: "muted" };
const ARROW: Style = { color: "borderAccent" };
const FRAME: DiagramColor = "borderMuted";

export interface RenderOptions {
	/** Where to see the whole diagram, for the hint under a cut-off one. Default `"/board"`. */
	fullView?: string;
}

/** A diagram body ready to paint: its grid and a style per cell. */
export interface Painted {
	grid: Grid;
	styles: Map<string, Style>;
	statuses: Status[];
}

const cellKey = (row: number, col: number) => `${row},${col}`;

/** Read the drawing and decide the style of every cell. */
export function paintBody(body: string): Painted {
	const lines = normalizeBody(body.replace(/\t/g, "    "))
		.split("\n")
		// eslint-disable-next-line no-control-regex -- control characters would break the grid
		.map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""));
	const grid = new Grid(lines);
	const styles = new Map<string, Style>();
	for (let r = 0; r < grid.height; r++) {
		const row = grid.rows[r]!;
		for (let c = 0; c < row.length; c++) {
			const ch = row[c]!;
			if (isArrow(ch)) styles.set(cellKey(r, c), ARROW);
			else if (isLine(ch)) styles.set(cellKey(r, c), LINE);
		}
	}
	const markers = findMarkers(grid);
	const boxes = markers.length ? findBoxes(grid) : [];
	for (const m of markers) {
		const color = STATUS_COLOR[m.status];
		const label: Style = { color, bold: true, strike: m.status === "removed" };
		const box = boxes
			.filter((b) => b.top < m.row && m.row < b.bottom && b.left < m.start && m.end < b.right)
			.sort((a, b) => (a.bottom - a.top) * (a.right - a.left) - (b.bottom - b.top) * (b.right - b.left))[0];
		if (box) {
			for (let r = box.top; r <= box.bottom; r++) {
				for (let c = box.left; c <= box.right; c++) {
					const ch = grid.at(r, c);
					const edge = r === box.top || r === box.bottom || c === box.left || c === box.right;
					if (edge && (isLine(ch) || !isBlank(ch))) styles.set(cellKey(r, c), { color });
					else if (!edge && !isBlank(ch) && !isLine(ch) && !isArrow(ch)) {
						styles.set(cellKey(r, c), r === m.row ? label : { color });
					}
				}
			}
		} else {
			// A marked label outside a box: colour the words just before the marker.
			let c = m.start - 1;
			if (isBlank(grid.at(m.row, c))) c--;
			while (c >= 0) {
				const ch = grid.at(m.row, c);
				if (isLine(ch) || isArrow(ch) || (isBlank(ch) && isBlank(grid.at(m.row, c - 1)))) break;
				if (!isBlank(ch)) styles.set(cellKey(m.row, c), label);
				c--;
			}
		}
		for (let c = m.start; c <= m.end; c++) styles.set(cellKey(m.row, c), { color });
	}
	const present = new Set(markers.map((m) => m.status));
	return { grid, styles, statuses: STATUSES.filter((s) => present.has(s)) };
}

/**
 * Columns `start..start+count-1` of one body row, themed. A wide character cut in half becomes a space, so the
 * result is never wider than `count`.
 */
export function paintRow(p: Painted, row: number, start: number, count: number, theme: DiagramTheme): string {
	let out = "";
	let run = "";
	let runStyle: Style | undefined;
	// Spaces join the run around them only when the run goes on after them, so no style trails into blank space.
	let blanks = "";
	const cells = p.grid.rows[row] ?? [];
	const end = Math.min(cells.length, start + count);
	for (let c = start; c < end; c++) {
		let ch = cells[c]!;
		if (ch === WIDE_TAIL) {
			if (c > start) continue;
			ch = " ";
		} else if (visibleWidth(ch) > 1 && c + 1 >= start + count) ch = " ";
		if (isBlank(ch)) {
			blanks += ch;
			continue;
		}
		const style = p.styles.get(cellKey(row, c));
		if (sameStyle(style, runStyle)) run += blanks;
		else {
			if (run) out += paint(run, runStyle, theme);
			out += blanks;
			run = "";
			runStyle = style;
		}
		blanks = "";
		run += ch;
	}
	if (run) out += paint(run, runStyle, theme);
	return out + blanks;
}

function sameStyle(a: Style | undefined, b: Style | undefined): boolean {
	return a?.color === b?.color && Boolean(a?.bold) === Boolean(b?.bold) && Boolean(a?.strike) === Boolean(b?.strike);
}

export function paint(text: string, style: Style | undefined, theme: DiagramTheme): string {
	if (!style) return text;
	let out = text;
	if (style.strike && theme.strikethrough) out = theme.strikethrough(out);
	if (style.bold) out = theme.bold(out);
	if (style.color) out = theme.fg(style.color, out);
	return out;
}

/** `■ new  ■ changed` for the statuses the diagram uses. */
export function legend(statuses: readonly Status[], theme: DiagramTheme): { text: string; width: number } {
	const text = statuses.map((s) => `${theme.fg(STATUS_COLOR[s], "■")} ${theme.fg("dim", s)}`).join("  ");
	return { text, width: statuses.reduce((w, s, i) => w + 2 + s.length + (i ? 2 : 0), 0) };
}

/**
 * The diagram as themed lines, none wider than `width`. It sits in a titled card when there is room, drops the
 * card when that makes it fit, and is cut (never wrapped) with `…` and a hint when even that is too narrow.
 */
export function renderDiagram(d: Diagram, width: number, theme: DiagramTheme, options: RenderOptions = {}): string[] {
	const w = Math.max(1, Math.floor(width));
	const p = paintBody(d.body);
	const title = clean(d.title) || "Diagram";
	const caption = d.caption ? clean(d.caption) : "";
	const bodyWidth = p.grid.width;
	// Every line is built to its exact width from measured parts, so a theme's escape codes never need measuring.
	return w >= bodyWidth + 4 && w >= 16
		? framed(p, title, caption, w, theme)
		: bare(p, title, caption, w, theme, options);
}

function framed(p: Painted, title: string, caption: string, width: number, theme: DiagramTheme): string[] {
	const bodyWidth = p.grid.width;
	const pad = width >= bodyWidth + 6 ? 2 : 1;
	const key = legend(p.statuses, theme);
	const titleText = truncate(title, width - 6);
	const inner = Math.min(
		width - 2,
		Math.max(bodyWidth + 2 * pad, visibleWidth(titleText) + 4, Math.min(48, width - 2)),
	);
	const border = (s: string) => theme.fg(FRAME, s);
	const row = (content: string, used: number) =>
		`${border("│")}${" ".repeat(pad)}${content}${" ".repeat(Math.max(0, inner - 2 * pad - used))}${" ".repeat(pad)}${border("│")}`;
	const out: string[] = [];
	const titleWidth = visibleWidth(titleText);
	out.push(
		`${border("╭─ ")}${theme.fg("accent", theme.bold(titleText))}${border(` ${"─".repeat(Math.max(0, inner - titleWidth - 3))}╮`)}`,
	);
	out.push(row("", 0));
	for (let r = 0; r < p.grid.height; r++) {
		const used = Math.min(bodyWidth, p.grid.rows[r]!.length);
		out.push(row(paintRow(p, r, 0, bodyWidth, theme), used));
	}
	out.push(row("", 0));
	if (caption) {
		for (const line of wrap(caption, inner - 2 * pad, 6)) out.push(row(theme.fg("dim", line), visibleWidth(line)));
		out.push(row("", 0));
	}
	if (key.width && key.width + 4 <= inner) {
		out.push(`${border("╰─ ")}${key.text}${border(` ${"─".repeat(Math.max(0, inner - key.width - 3))}╯`)}`);
	} else out.push(border(`╰${"─".repeat(inner)}╯`));
	return out;
}

function bare(
	p: Painted,
	title: string,
	caption: string,
	width: number,
	theme: DiagramTheme,
	options: RenderOptions,
): string[] {
	const bodyWidth = p.grid.width;
	const cut = bodyWidth > width;
	const out = [theme.fg("accent", theme.bold(truncate(title, width)))];
	for (let r = 0; r < p.grid.height; r++) {
		const long = (p.grid.rows[r]?.length ?? 0) > width;
		out.push(long ? `${paintRow(p, r, 0, width - 1, theme)}${theme.fg("dim", "…")}` : paintRow(p, r, 0, width, theme));
	}
	if (caption) for (const line of wrap(caption, width, 6)) out.push(theme.fg("dim", line));
	const key = legend(p.statuses, theme);
	if (key.width && key.width <= width) out.push(key.text);
	if (cut) {
		const full = options.fullView ?? "/board";
		const hints = [
			`diagram is ${bodyWidth} cols wide, widen the terminal or open ${full}`,
			`${bodyWidth} cols wide · open ${full} to see it all`,
			`${bodyWidth} cols · ${full}`,
		];
		const hint = hints.find((h) => visibleWidth(h) <= width) ?? hints[hints.length - 1]!;
		out.push(theme.fg("dim", truncate(hint, width)));
	}
	return out;
}

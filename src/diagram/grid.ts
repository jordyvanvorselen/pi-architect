// A diagram body as a grid of terminal columns, with what every box-drawing character connects to, and the
// boxes found by their corners. Shared by the linter and the renderer, so both read a drawing the same way.
import { graphemes } from "./text.ts";

export const UP = 1;
export const DOWN = 2;
export const LEFT = 4;
export const RIGHT = 8;

const ARMS = new Map<string, number>();
const add = (chars: string, arms: number) => {
	for (const ch of chars) ARMS.set(ch, arms);
};
add("─━┄┅┈┉╌╍═╼╾", LEFT | RIGHT);
add("│┃┆┇┊┋╎╏║╽╿", UP | DOWN);
add("╭┌┍┎┏╒╓╔", DOWN | RIGHT);
add("╮┐┑┒┓╕╖╗", DOWN | LEFT);
add("╰└┕┖┗╘╙╚", UP | RIGHT);
add("╯┘┙┚┛╛╜╝", UP | LEFT);
add("├┝┞┟┠┡┢┣╞╟╠", UP | DOWN | RIGHT);
add("┤┥┦┧┨┩┪┫╡╢╣", UP | DOWN | LEFT);
add("┬┭┮┯┰┱┲┳╤╥╦", DOWN | LEFT | RIGHT);
add("┴┵┶┷┸┹┺┻╧╨╩", UP | LEFT | RIGHT);
add("┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╪╫╬", UP | DOWN | LEFT | RIGHT);
add("╴╸", LEFT);
add("╵╹", UP);
add("╶╺", RIGHT);
add("╷╻", DOWN);

/** Arrowheads, by the direction they point. Their one arm is the side the line comes from. */
const ARROWS = new Map<string, number>();
const arrow = (chars: string, points: number) => {
	for (const ch of chars) ARROWS.set(ch, points);
};
arrow("▶►▷▸→⟶⇒⇢", RIGHT);
arrow("◀◄◁◂←⟵⇐⇠", LEFT);
arrow("▼▽▾↓⇓⇣", DOWN);
arrow("▲△▴↑⇑⇡", UP);

export const OPPOSITE: Record<number, number> = { [UP]: DOWN, [DOWN]: UP, [LEFT]: RIGHT, [RIGHT]: LEFT };
export const STEP: Record<number, [number, number]> = {
	[UP]: [-1, 0],
	[DOWN]: [1, 0],
	[LEFT]: [0, -1],
	[RIGHT]: [0, 1],
};
export const DIRECTIONS = [UP, DOWN, LEFT, RIGHT] as const;

/** The directions a character's lines reach out to. Arrowheads reach back toward their tail. */
export function arms(ch: string): number {
	const a = ARMS.get(ch);
	if (a !== undefined) return a;
	const points = ARROWS.get(ch);
	return points === undefined ? 0 : OPPOSITE[points]!;
}

/** Which way an arrowhead points, or 0. */
export function arrowDirection(ch: string): number {
	return ARROWS.get(ch) ?? 0;
}

export function isLine(ch: string): boolean {
	return ARMS.has(ch);
}

export function isArrow(ch: string): boolean {
	return ARROWS.has(ch);
}

export const isTopLeft = (ch: string) => ARMS.get(ch) === (DOWN | RIGHT);
export const isTopRight = (ch: string) => ARMS.get(ch) === (DOWN | LEFT);
export const isBottomLeft = (ch: string) => ARMS.get(ch) === (UP | RIGHT);
export const isBottomRight = (ch: string) => ARMS.get(ch) === (UP | LEFT);
/** Carries a vertical line through: `│`, `├`, `┼`, … */
export const isVertical = (ch: string) => ((ARMS.get(ch) ?? 0) & (UP | DOWN)) === (UP | DOWN);
/** Carries a horizontal line through: `─`, `┬`, `┼`, … */
export const isHorizontal = (ch: string) => ((ARMS.get(ch) ?? 0) & (LEFT | RIGHT)) === (LEFT | RIGHT);
export const isBlank = (ch: string) => ch === " ";

/** Graphemes of two columns leave this in their second column. */
export const WIDE_TAIL = "";

export class Grid {
	readonly rows: string[][];
	/** Columns that hold a two-column grapheme. */
	readonly wide: Set<number>[];
	readonly width: number;

	constructor(lines: readonly string[]) {
		this.rows = [];
		this.wide = [];
		for (const line of lines) {
			const row: string[] = [];
			const wide = new Set<number>();
			for (const { g, w } of graphemes(line)) {
				if (w > 1) wide.add(row.length);
				row.push(g);
				for (let i = 1; i < w; i++) row.push(WIDE_TAIL);
			}
			this.rows.push(row);
			this.wide.push(wide);
		}
		this.width = Math.max(0, ...this.rows.map((r) => r.length));
	}

	get height(): number {
		return this.rows.length;
	}

	/** The grapheme starting at a column; `" "` outside the drawing, `""` for the second half of a wide one. */
	at(row: number, col: number): string {
		if (row < 0 || col < 0) return " ";
		return this.rows[row]?.[col] ?? " ";
	}

	/** Wide graphemes between two columns of a row. */
	wideIn(row: number, from: number, to: number): string[] {
		const out: string[] = [];
		for (const col of this.wide[row] ?? []) if (col > from && col < to) out.push(this.at(row, col));
		return out;
	}
}

export interface Box {
	top: number;
	left: number;
	bottom: number;
	right: number;
}

/**
 * The top edge that starts at a top-left corner: `╭`, then `─` (junctions, crossings and a single-spaced title
 * allowed), up to the first top-right corner. Returns its column, or -1 when this is not a box top.
 */
export function topEdge(grid: Grid, row: number, col: number): number {
	if (!isTopLeft(grid.at(row, col))) return -1;
	if (!isHorizontal(grid.at(row, col + 1))) return -1;
	return edgeEnd(grid, row, col, isTopRight, isTopLeft);
}

/** Same for a bottom edge, from `╰` to the first `╯`. */
export function bottomEdge(grid: Grid, row: number, col: number): number {
	if (!isBottomLeft(grid.at(row, col))) return -1;
	if (!isHorizontal(grid.at(row, col + 1))) return -1;
	return edgeEnd(grid, row, col, isBottomRight, isBottomLeft);
}

function edgeEnd(
	grid: Grid,
	row: number,
	col: number,
	closes: (ch: string) => boolean,
	opens: (ch: string) => boolean,
) {
	for (let c = col + 1; c < grid.width + 1; c++) {
		const ch = grid.at(row, c);
		if (closes(ch)) return c;
		if (opens(ch) || isArrow(ch)) return -1;
		if (isBlank(ch) && isBlank(grid.at(row, c + 1))) return -1;
		if (isLine(ch) && !isHorizontal(ch) && !isVertical(ch)) return -1;
	}
	return -1;
}

/** Whether a row between `left` and `right` can be the top or bottom edge of a box. */
function edgeRow(grid: Grid, row: number, left: number, right: number, top: boolean): boolean {
	return (top ? topEdge(grid, row, left) : bottomEdge(grid, row, left)) === right;
}

/**
 * Every well-formed box: a top edge, a bottom edge in the same columns, and sides that carry a vertical line on
 * every row between them. Lines may cross the sides (`┼`, or `─` passing through).
 */
export function findBoxes(grid: Grid): Box[] {
	const boxes: Box[] = [];
	for (let top = 0; top < grid.height; top++) {
		for (let left = 0; left < (grid.rows[top]?.length ?? 0); left++) {
			const right = topEdge(grid, top, left);
			if (right < 0) continue;
			const bottom = closingRow(grid, top, left, right);
			if (bottom < 0) continue;
			let sound = true;
			for (let r = top + 1; r < bottom && sound; r++) sound = side(grid.at(r, left)) && side(grid.at(r, right));
			if (sound) boxes.push({ top, left, bottom, right });
		}
	}
	return boxes;
}

/** A cell that keeps a box side going: a vertical line, or a line crossing through it. */
export function side(ch: string): boolean {
	return isVertical(ch) || isHorizontal(ch);
}

/**
 * The row of the bottom edge that closes a box top, or -1. Stops at anything that says this is a line and not a
 * box: an arrowhead or another box top in the side columns.
 */
export function closingRow(grid: Grid, top: number, left: number, right: number): number {
	for (let r = top + 1; r < grid.height; r++) {
		const l = grid.at(r, left);
		const rr = grid.at(r, right);
		if (isBottomLeft(l) && isBottomRight(rr) && edgeRow(grid, r, left, right, false)) return r;
		if (isArrow(l) || isArrow(rr) || isTopLeft(l) || isTopRight(rr)) return -1;
		if (isBottomLeft(l) && isBottomRight(rr)) return -1;
	}
	return -1;
}

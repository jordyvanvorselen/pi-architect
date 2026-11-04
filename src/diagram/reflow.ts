// Row reflow: the repair for drift. A model that miscounts the padding inside a box pushes the box's right side
// a column further on each row it miscounts, and everything to the right on that row with it. The top edge of
// every box says where its sides belong; this walks each row left to right and resizes the space runs before
// an edge that sits off its column, so the rest of the row moves back with it. Text is never changed: only
// runs of spaces (or, when there are none, plain line runs) grow or shrink, and never to nothing.
import {
	arrowDirection,
	bottomEdge,
	DOWN,
	Grid,
	isArrow,
	isBlank,
	isBottomLeft,
	isBottomRight,
	isHorizontal,
	isLine,
	isTopLeft,
	isVertical,
	side,
	topEdge,
	UP,
	WIDE_TAIL,
} from "./grid.ts";

/** How far an edge may sit from its column and still be found: one box's drift plus some slack. */
const WINDOW = 4;

/** What the reflow did to one box, for the message to the model. */
export interface ReflowEdit {
	name: string;
	top: number;
	left: number;
	right: number;
	/** Rows where a side moved back into line, and where the bottom edge did. */
	rows: number[];
	sides: Set<"left" | "right">;
	bottom: number | undefined;
	/** Columns each moved edge was off. */
	offsets: number[];
	/** Only padding inside the box (spaces) changed, no line runs. */
	padding: boolean;
}

export interface ReflowResult {
	lines: string[];
	edits: ReflowEdit[];
}

interface Open {
	top: number;
	left: number;
	right: number;
	bottom: number;
	edit: ReflowEdit;
}

type Which = "left" | "right" | "bl" | "br";

interface Anchor {
	col: number;
	which: Which;
	box: Open;
}

/**
 * Reflow every row so each box's sides and bottom corners sit in the columns its top edge set. Returns
 * undefined when nothing needed it, or when some row has no single clean reading: then nothing changes.
 */
export function reflowBody(lines: readonly string[]): ReflowResult | undefined {
	const rows = new Grid(lines).rows.map((row) => [...row]);
	const open: Open[] = [];
	const edits: ReflowEdit[] = [];
	for (let r = 0; r < rows.length; r++) {
		const row = rows[r]!;
		const anchors: Anchor[] = [];
		for (const box of open) {
			if (r === box.bottom) {
				anchors.push({ col: box.left, which: "bl", box }, { col: box.right, which: "br", box });
			} else anchors.push({ col: box.left, which: "left", box }, { col: box.right, which: "right", box });
		}
		anchors.sort((a, b) => a.col - b.col);
		let prev = -1;
		for (const anchor of anchors) {
			const at = locate(row, anchor, prev);
			if (at === undefined) return undefined;
			const k = at - anchor.col;
			if (k !== 0) {
				const fixed = k > 0 ? shrink(row, prev, at, k, anchor.which) : grow(row, prev, at, -k, anchor.which);
				if (!fixed) return undefined;
				const edit = anchor.box.edit;
				if (anchor.which === "left" || anchor.which === "right") {
					if (!edit.rows.includes(r)) edit.rows.push(r);
					edit.sides.add(anchor.which);
				} else edit.bottom = r;
				edit.offsets.push(Math.abs(k));
				if (fixed === "line" && anchor.which !== "br") edit.padding = false;
				if (!edits.includes(edit)) edits.push(edit);
			}
			prev = anchor.col;
		}
		for (let i = open.length - 1; i >= 0; i--) if (open[i]!.bottom === r) open.splice(i, 1);
		const grid = new Grid(rows.map((cells) => cells.join("")));
		for (let c = 0; c < row.length; c++) {
			const right = topEdge(grid, r, c);
			if (right < 0) continue;
			const bottom = closing(grid, r, c, right);
			if (bottom < 0) continue;
			open.push({
				top: r,
				left: c,
				right,
				bottom,
				edit: {
					name: "",
					top: r,
					left: c,
					right,
					rows: [],
					sides: new Set(),
					bottom: undefined,
					offsets: [],
					padding: true,
				},
			});
		}
	}
	if (!edits.length) return undefined;
	const out = rows.map((cells) => cells.join("").trimEnd());
	const final = new Grid(out);
	for (const edit of edits) edit.name = boxName(final, edit.top, edit.left, edit.right);
	return { lines: out, edits };
}

/** Whether a cell can be the given part of a box. */
function fits(ch: string, which: Which): boolean {
	if (which === "bl") return isBottomLeft(ch);
	if (which === "br") return isBottomRight(ch);
	return isVertical(ch);
}

/**
 * The column where an anchor's edge actually is on this row: its own column when the edge is there, else the
 * one nearest cell of the right kind within reach, after the previous anchor. Two equally near: no reading.
 */
function locate(row: string[], anchor: Anchor, prev: number): number | undefined {
	const { col, which } = anchor;
	const here = row[col] ?? " ";
	if (col > prev && (fits(here, which) || ((which === "left" || which === "right") && side(here)))) return col;
	for (let d = 1; d <= WINDOW; d++) {
		const found = [col - d, col + d].filter((c) => c > prev && fits(row[c] ?? " ", which));
		if (found.length > 1) return undefined;
		if (found.length === 1) {
			const at = found[0]!;
			// Anything of the same kind between the column and the edge found makes it a different edge.
			const [a, b] = at < col ? [at, col] : [col, at];
			for (let c = a + 1; c < b; c++) if (fits(row[c] ?? " ", which)) return undefined;
			return at;
		}
	}
	return undefined;
}

interface Run {
	start: number;
	length: number;
}

/** Runs of `test` cells strictly between `from` and `to`, nearest to `to` first. */
function runs(row: string[], from: number, to: number, test: (ch: string) => boolean): Run[] {
	const out: Run[] = [];
	let c = to - 1;
	while (c > from) {
		if (!test(row[c] ?? " ")) {
			c--;
			continue;
		}
		let start = c;
		while (start - 1 > from && test(row[start - 1] ?? " ")) start--;
		out.push({ start, length: c - start + 1 });
		c = start - 1;
	}
	return out;
}

/** A plain line cell that can be dropped or doubled without changing what the line joins. */
const plainLine = (ch: string) => isHorizontal(ch) && /[─━┄┅┈┉╌╍═]/.test(ch);

/**
 * Delete `k` cells before the edge at `at`: from the nearest run of spaces that keeps at least one space, or for
 * a bottom edge (or when no spaces will do) from the nearest plain line run that keeps at least one cell.
 */
function shrink(row: string[], prev: number, at: number, k: number, which: Which): "space" | "line" | undefined {
	const tries: ["space" | "line", (ch: string) => boolean][] =
		which === "br"
			? [["line", plainLine]]
			: [
					["space", isBlank],
					["line", plainLine],
				];
	for (const [kind, test] of tries) {
		const run = runs(row, prev, at, test).find((r) => r.length - k >= 1);
		if (!run) continue;
		row.splice(run.start + run.length - k, k);
		return kind;
	}
	return undefined;
}

/**
 * Insert `k` cells before the edge at `at`: spaces right before it when text or space is there, else into the
 * nearest run of spaces; a bottom edge (or a line that runs into the edge) grows by its own line character.
 */
function grow(row: string[], prev: number, at: number, k: number, which: Which): "space" | "line" | undefined {
	const before = row[at - 1] ?? " ";
	const fill = (ch: string) => Array.from({ length: k }, () => ch);
	if (which === "br") {
		if (!plainLine(before)) return undefined;
		row.splice(at, 0, ...fill(before));
		return "line";
	}
	if (at - 1 > prev && before !== WIDE_TAIL && (isBlank(before) || (!isLine(before) && !isArrow(before)))) {
		row.splice(at, 0, ...fill(" "));
		return "space";
	}
	const space = runs(row, prev, at, isBlank)[0];
	if (space) {
		row.splice(space.start, 0, ...fill(" "));
		return "space";
	}
	const line = runs(row, prev, at, plainLine)[0];
	if (line) {
		row.splice(line.start, 0, ...fill(row[line.start]!));
		return "line";
	}
	return undefined;
}

/**
 * The row that closes a box top, allowing for drift: the first row below with a `╰` near the left column whose
 * bottom edge ends near the right column. Another box top or an arrowhead in the side columns first means the
 * top was a line, not a box.
 */
function closing(grid: Grid, top: number, left: number, right: number): number {
	for (let r = top + 1; r < grid.height; r++) {
		// A line running down into an arrowhead in a side column, or a box top there, is not this box's side.
		const down = (ch: string) => arrowDirection(ch) === DOWN || arrowDirection(ch) === UP;
		if (down(grid.at(r, left)) || down(grid.at(r, right)) || isTopLeft(grid.at(r, left))) return -1;
		for (let d = 0; d <= WINDOW; d++) {
			for (const c of d ? [left - d, left + d] : [left]) {
				if (!isBottomLeft(grid.at(r, c))) continue;
				const end = bottomEdge(grid, r, c);
				if (end >= 0 && Math.abs(end - right) <= 2 * WINDOW) return r;
			}
		}
		let sideNear = false;
		for (let c = left - WINDOW; c <= left + WINDOW && !sideNear; c++) sideNear = isVertical(grid.at(r, c));
		if (!sideNear) return -1;
	}
	return -1;
}

/** A name for a box in messages: its title, or the text on its first line. */
function boxName(grid: Grid, top: number, left: number, right: number): string {
	const title = grid.rows[top]!.slice(left + 1, right)
		.join("")
		.replace(/[─━┄┅┈┉╌╍═┬┴┼]/g, " ")
		.trim();
	const first = (grid.rows[top + 1] ?? [])
		.slice(left + 1, right)
		.join("")
		.trim();
	const name = (title || first).replace(/\s+/g, " ");
	return name.length > 30 ? `${name.slice(0, 29)}…` : name;
}

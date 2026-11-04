// Safe repairs for the slips a model makes most when it draws boxes: a corner or a side one column off, and a
// line that meets a box edge without a junction. Each repair is tried on a copy and kept only when the linter
// then finds strictly less and nothing new, so a repair can never make a drawing worse. Anything with more than
// one reading is left for the model to fix.
import {
	arms,
	bottomEdge,
	closingRow,
	DOWN,
	findBoxes,
	Grid,
	isBlank,
	isBottomLeft,
	isBottomRight,
	isHorizontal,
	isVertical,
	LEFT,
	OPPOSITE,
	RIGHT,
	side,
	STEP,
	topEdge,
	UP,
	type Box,
} from "./grid.ts";
import { type DiagramFinding, lintBody } from "./lint.ts";

/** One repair, 1-based like the linter's findings, with what was done. */
export interface DiagramRepair {
	line: number;
	col: number;
	message: string;
}

export interface RepairResult {
	lines: string[];
	repairs: DiagramRepair[];
}

/** A change to try: cells to set, and what to tell the model when it is kept. */
interface Candidate {
	cells: { r: number; c: number; ch: string }[];
	repair: DiagramRepair;
}

/** Most repairs in one drawing. More slips than this and the drawing needs the model's eye, not patches. */
const MAX_REPAIRS = 12;

const PLAIN_H = "─";
const PLAIN_V = "│";
/** A light line plus one arm, for a line that meets it: `─` with a line below is `┬`. */
const JUNCTION: Record<string, Record<number, string>> = {
	[PLAIN_H]: { [UP]: "┴", [DOWN]: "┬" },
	[PLAIN_V]: { [LEFT]: "┤", [RIGHT]: "├" },
};

/** Repair what is safe to repair, and say what was done. Lines without a repair come back as they were. */
export function repairBody(lines: readonly string[]): RepairResult {
	let current = [...lines];
	let findings = lintBody(current);
	const repairs: DiagramRepair[] = [];
	while (findings.length && repairs.length < MAX_REPAIRS) {
		const grid = new Grid(current);
		let kept = false;
		for (const candidate of candidates(grid)) {
			const next = apply(grid, candidate);
			const after = lintBody(next);
			if (!better(findings, after)) continue;
			current = next;
			findings = after;
			repairs.push(candidate.repair);
			kept = true;
			break;
		}
		if (!kept) break;
	}
	return { lines: current, repairs };
}

const keyOf = (f: DiagramFinding) => `${f.line}:${f.severity}:${f.message}`;

/** Fewer findings, no more errors or warnings, and no finding that was not there before. */
function better(before: DiagramFinding[], after: DiagramFinding[]): boolean {
	const count = (fs: DiagramFinding[], s: DiagramFinding["severity"]) => fs.filter((f) => f.severity === s).length;
	if (after.length >= before.length) return false;
	if (count(after, "error") > count(before, "error") || count(after, "warning") > count(before, "warning"))
		return false;
	const known = new Set(before.map(keyOf));
	return after.every((f) => known.has(keyOf(f)));
}

function apply(grid: Grid, candidate: Candidate): string[] {
	const rows = grid.rows.map((row) => [...row]);
	for (const { r, c, ch } of candidate.cells) {
		const row = rows[r]!;
		while (row.length <= c) row.push(" ");
		row[c] = ch;
	}
	return rows.map((row) => row.join("").trimEnd());
}

function* candidates(grid: Grid): Generator<Candidate> {
	yield* cornerRepairs(grid);
	yield* sideRepairs(grid);
	yield* junctionRepairs(grid);
}

/** Whether a neighbour of (r, c) other than the ones in `except` reaches into it. */
function reachedFrom(grid: Grid, r: number, c: number, except: number[]): boolean {
	for (const dir of [UP, DOWN, LEFT, RIGHT]) {
		if (except.includes(dir)) continue;
		const [dr, dc] = STEP[dir]!;
		if (arms(grid.at(r + dr, c + dc)) & OPPOSITE[dir]!) return true;
	}
	return false;
}

/** First row below `top` where column `col` stops carrying a box side. */
function run(grid: Grid, top: number, col: number): number {
	let r = top + 1;
	while (r < grid.height && side(grid.at(r, col))) r++;
	return r;
}

/** The `╰` that starts the bottom edge ending in the `╯` at (row, col), or -1. */
function bottomStart(grid: Grid, row: number, col: number): number {
	for (let c = col - 1; c >= 0; c--) {
		const ch = grid.at(row, c);
		if (isBottomLeft(ch)) return bottomEdge(grid, row, c) === col ? c : -1;
		if (!isHorizontal(ch)) return -1;
	}
	return -1;
}

/**
 * A box whose corners do not line up by exactly one column, where the sides say clearly which corner is off:
 * the sides run straight down from one of the two columns and not from the other.
 */
function* cornerRepairs(grid: Grid): Generator<Candidate> {
	for (let top = 0; top < grid.height; top++) {
		for (let left = 0; left < (grid.rows[top]?.length ?? 0); left++) {
			const right = topEdge(grid, top, left);
			if (right < 0 || closingRow(grid, top, left, right) >= 0) continue;
			const leftEnd = run(grid, top, left);
			const rightEnd = run(grid, top, right);
			if (isBottomLeft(grid.at(leftEnd, left))) {
				const end = bottomEdge(grid, leftEnd, left);
				if (end < 0 || Math.abs(end - right) !== 1) continue;
				const atTop = rightEnd >= leftEnd;
				const atBottom = run(grid, top, end) >= leftEnd;
				if (atTop === atBottom) continue;
				const move = atTop ? moveCorner(grid, leftEnd, end, right, top) : moveCorner(grid, top, right, end, leftEnd);
				if (move) yield move;
			} else if (isBottomRight(grid.at(rightEnd, right))) {
				const start = bottomStart(grid, rightEnd, right);
				if (start < 0 || Math.abs(start - left) !== 1) continue;
				const atTop = leftEnd >= rightEnd;
				const atBottom = run(grid, top, start) >= rightEnd;
				if (atTop === atBottom) continue;
				const move = atTop
					? moveCorner(grid, rightEnd, start, left, top)
					: moveCorner(grid, top, left, start, rightEnd);
				if (move) yield move;
			}
		}
	}
}

/** Move the corner at (r, from) one column to `to`, so it lines up with the corner on row `other`. */
function moveCorner(grid: Grid, r: number, from: number, to: number, other: number): Candidate | undefined {
	if (grid.wide[r]?.size) return undefined;
	const corner = grid.at(r, from);
	const a = arms(corner);
	const toward = to > from ? RIGHT : LEFT;
	const vertical = a & (UP | DOWN);
	const cells: Candidate["cells"] = [];
	if (a & toward) {
		// The edge is one too long: the corner steps onto the last edge cell, and its old cell clears.
		if (grid.at(r, to) !== PLAIN_H && !isHorizontal(grid.at(r, to))) return undefined;
		if (reachedFrom(grid, r, from, [toward])) return undefined;
		cells.push({ r, c: to, ch: corner }, { r, c: from, ch: " " });
	} else {
		// The edge is one too short: the corner steps into the space, and the edge grows into its old cell.
		if (!isBlank(grid.at(r, to))) return undefined;
		if (reachedFrom(grid, r, from, [OPPOSITE[toward]!])) return undefined;
		if (reachedFrom(grid, r, to, [vertical === UP ? UP : DOWN, OPPOSITE[toward]!])) return undefined;
		const edge = grid.at(r, from - (to - from));
		cells.push({ r, c: to, ch: corner }, { r, c: from, ch: isHorizontal(edge) ? edge : PLAIN_H });
	}
	return {
		cells,
		repair: {
			line: r + 1,
			col: from + 1,
			message: `moved ${corner} from col ${from + 1} to col ${to + 1}, in line with the corner on line ${other + 1}`,
		},
	};
}

/**
 * A closed box with one side broken on some rows, where that side's line sits exactly one column off on each
 * of them and the side's own column is a space there.
 */
function* sideRepairs(grid: Grid): Generator<Candidate> {
	for (let top = 0; top < grid.height; top++) {
		for (let left = 0; left < (grid.rows[top]?.length ?? 0); left++) {
			const right = topEdge(grid, top, left);
			if (right < 0) continue;
			const bottom = closingRow(grid, top, left, right);
			if (bottom < 0) continue;
			const box = { top, left, bottom, right };
			const badLeft = broken(grid, box, left);
			const badRight = broken(grid, box, right);
			if (badLeft.length && badRight.length) continue;
			const col = badLeft.length ? left : right;
			const rows = badLeft.length ? badLeft : badRight;
			if (!rows.length) continue;
			const cells: Candidate["cells"] = [];
			const moved: string[] = [];
			const chars = new Set<string>();
			for (const r of rows) {
				const move = moveSide(grid, box, r, col, new Set(rows));
				if (!move) {
					cells.length = 0;
					break;
				}
				cells.push(...move.cells);
				moved.push(`${move.from + 1}`);
				chars.add(grid.at(r, move.from));
			}
			if (!cells.length) continue;
			const lines = rows.map((r) => r + 1);
			yield {
				cells,
				repair: {
					line: rows[0]! + 1,
					col: col + 1,
					message: `moved the box side ${[...chars].join(" ")} to col ${col + 1} on line${lines.length > 1 ? "s" : ""} ${lines.join(", ")} (it was at col ${[...new Set(moved)].join(", ")}), in line with the box opened at line ${top + 1} col ${left + 1}`,
				},
			};
		}
	}
}

function broken(grid: Grid, box: Box, col: number): number[] {
	const rows: number[] = [];
	for (let r = box.top + 1; r < box.bottom; r++) if (!side(grid.at(r, col))) rows.push(r);
	return rows;
}

function moveSide(
	grid: Grid,
	box: Box,
	r: number,
	col: number,
	moving: Set<number>,
): { cells: Candidate["cells"]; from: number } | undefined {
	if (grid.wide[r]?.size || !isBlank(grid.at(r, col))) return undefined;
	const found = [col - 1, col + 1].filter((c) => c !== box.left && c !== box.right && isVertical(grid.at(r, c)));
	if (found.length !== 1) return undefined;
	const from = found[0]!;
	const ch = grid.at(r, from);
	const a = arms(ch);
	const away = from > col ? RIGHT : LEFT;
	// Lines above or below the old cell belong to something else, unless they are the same side moving too.
	if (arms(grid.at(r - 1, from)) & DOWN && !moving.has(r - 1)) return undefined;
	if (arms(grid.at(r + 1, from)) & UP && !moving.has(r + 1)) return undefined;
	let fill = " ";
	if (a & away) {
		// A junction whose line goes on outward: the line grows into the old cell.
		if (!(arms(grid.at(r, from + (from - col))) & OPPOSITE[away]!)) return undefined;
		fill = PLAIN_H;
	} else if (arms(grid.at(r, from + (from - col))) & OPPOSITE[away]!) return undefined;
	// An arm toward the side's column would point past it after the move.
	if (a & OPPOSITE[away]! && !(arms(grid.at(r, col - (from - col))) & away)) return undefined;
	return {
		cells: [
			{ r, c: col, ch },
			{ r, c: from, ch: fill },
		],
		from,
	};
}

/** A straight light line that meets a light box edge without a junction: draw the junction it clearly needs. */
function* junctionRepairs(grid: Grid): Generator<Candidate> {
	const edges = new Set<string>();
	for (const box of findBoxes(grid)) {
		for (let c = box.left + 1; c < box.right; c++) edges.add(`${box.top},${c}`).add(`${box.bottom},${c}`);
		for (let r = box.top + 1; r < box.bottom; r++) edges.add(`${r},${box.left}`).add(`${r},${box.right}`);
	}
	for (let r = 0; r < grid.height; r++) {
		for (let c = 0; c < (grid.rows[r]?.length ?? 0); c++) {
			const ch = grid.at(r, c);
			if (ch !== PLAIN_H && ch !== PLAIN_V) continue;
			for (const dir of ch === PLAIN_H ? [LEFT, RIGHT] : [UP, DOWN]) {
				const [dr, dc] = STEP[dir]!;
				const n = grid.at(r + dr, c + dc);
				const junction = JUNCTION[n]?.[OPPOSITE[dir]!];
				if (!junction || !edges.has(`${r + dr},${c + dc}`)) continue;
				yield {
					cells: [{ r: r + dr, c: c + dc, ch: junction }],
					repair: {
						line: r + dr + 1,
						col: c + dc + 1,
						message: `drew ${junction} where the line ${dir === UP ? "from below" : dir === DOWN ? "from above" : dir === LEFT ? "from the right" : "from the left"} meets the box edge`,
					},
				};
			}
		}
	}
}

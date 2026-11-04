// The alignment linter: finds the mistakes that break a hand-drawn diagram (boxes that do not close, sides out of
// line, junctions without an arm, arrows that miss their target) and says how to fix each one. It is careful on
// purpose: a finding the model cannot act on makes it redraw a good diagram, so text is never judged and only
// clear breakage is an error.
import {
	arms,
	arrowDirection,
	bottomEdge,
	type Box,
	closingRow,
	DIRECTIONS,
	DOWN,
	Grid,
	isBlank,
	isBottomLeft,
	isBottomRight,
	isHorizontal,
	isLine,
	isVertical,
	LEFT,
	OPPOSITE,
	RIGHT,
	side,
	STEP,
	topEdge,
	UP,
} from "./grid.ts";

export type Severity = "error" | "warning";

/** One problem in a diagram body. `line` and `col` are 1-based, `col` in terminal columns. */
export interface DiagramFinding {
	line: number;
	col: number;
	severity: Severity;
	message: string;
}

interface Found extends DiagramFinding {
	/** The cell the finding is about, `row,col` (0-based), for de-duplication. */
	target: string;
	box: boolean;
}

const DASHED = /[┄┅┈┉╌╍┆┇┊┋╎╏]/;
const NAMES: Record<number, string> = {
	[UP]: "above",
	[DOWN]: "below",
	[LEFT]: "to its left",
	[RIGHT]: "to its right",
};
const key = (r: number, c: number) => `${r},${c}`;

/** All findings for a drawing, most severe first. */
export function lintBody(lines: readonly string[]): DiagramFinding[] {
	const grid = new Grid(lines);
	const found: Found[] = [];
	const explained = new Set<string>();
	let box = true;
	const report = (r: number, c: number, severity: Severity, message: string, target = key(r, c)) =>
		found.push({ line: r + 1, col: c + 1, severity, message, target, box });

	checkBoxes(grid, report, explained);
	box = false;
	checkArms(grid, report);
	checkArrows(grid, report);

	// A broken box explains the corner and line findings around it: keep only the box finding.
	const kept = found.filter((f) => f.box || (!explained.has(f.target) && !explained.has(key(f.line - 1, f.col - 1))));
	const errors = kept.filter((f) => f.severity === "error");
	const unique = new Map<string, Found>();
	for (const f of kept) {
		if (
			f.severity === "warning" &&
			errors.some((e) => Math.abs(e.line - f.line) <= 1 && Math.abs(e.col - f.col) <= 1)
		) {
			continue;
		}
		if (!unique.has(f.target)) unique.set(f.target, f);
	}
	return [...unique.values()]
		.sort((a, b) => rank(a) - rank(b) || a.line - b.line || a.col - b.col)
		.map(({ line, col, severity, message }) => ({ line, col, severity, message }));
}

function rank(f: DiagramFinding): number {
	return f.severity === "error" ? 0 : 1;
}

type Report = (r: number, c: number, severity: Severity, message: string, target?: string) => void;

/** Boxes found by their corners must close in a straight rectangle. */
function checkBoxes(grid: Grid, report: Report, explained: Set<string>): void {
	for (let top = 0; top < grid.height; top++) {
		for (let left = 0; left < (grid.rows[top]?.length ?? 0); left++) {
			const right = topEdge(grid, top, left);
			if (right < 0) continue;
			const opened = `box opened at line ${top + 1} col ${left + 1}`;
			const bottom = closingRow(grid, top, left, right);
			if (bottom >= 0) {
				const box = { top, left, bottom, right };
				const badLeft = brokenRows(grid, box, left);
				const badRight = brokenRows(grid, box, right);
				// Both sides broken: more likely lines that only look like a box. Stay quiet.
				if (badLeft.length && badRight.length) continue;
				for (const [bad, col] of [
					[badLeft, left],
					[badRight, right],
				] as const) {
					const first = bad[0];
					if (first === undefined) continue;
					const more = bad.length > 1 ? ` (${bad.length} lines)` : "";
					report(first, col, "error", `box side │ missing${more} (${opened}).${sideHint(grid, box, first, col)}`);
				}
				if (badLeft.length || badRight.length) explain(explained, box);
				else checkCorners(grid, report, box, opened);
				continue;
			}
			const leftEnd = run(grid, top, left);
			const rightEnd = run(grid, top, right);
			if (isBottomLeft(grid.at(leftEnd, left))) {
				const end = bottomEdge(grid, leftEnd, left);
				if (end < 0 || end === right) continue;
				misaligned(grid, report, { top, left, bottom: leftEnd, right }, end, rightEnd, opened, "right");
				explain(explained, { top, left, bottom: leftEnd, right });
			} else if (isBottomRight(grid.at(rightEnd, right))) {
				const start = bottomStart(grid, rightEnd, right);
				if (start < 0 || start === left) continue;
				misaligned(grid, report, { top, left, bottom: rightEnd, right }, start, leftEnd, opened, "left");
				explain(explained, { top, left, bottom: rightEnd, right });
			}
		}
	}
}

/** Rounded and square light corners, top left, top right, bottom left, bottom right. */
export const CORNER_STYLES = { rounded: "╭╮╰╯", square: "┌┐└┘" } as const;

/** The corner of the other style in the same place: `╮` for `┐`. */
export function matchingCorner(ch: string, style: keyof typeof CORNER_STYLES): string | undefined {
	for (const chars of Object.values(CORNER_STYLES)) {
		const i = chars.indexOf(ch);
		if (i >= 0) return CORNER_STYLES[style][i];
	}
	return undefined;
}

/** The style most corners of a box share, when exactly one corner differs. */
export function oddCorner(
	corners: readonly string[],
): { index: number; style: keyof typeof CORNER_STYLES } | undefined {
	const styles = corners.map((ch) =>
		CORNER_STYLES.rounded.includes(ch) ? "rounded" : CORNER_STYLES.square.includes(ch) ? "square" : undefined,
	);
	if (styles.some((s) => s === undefined)) return undefined;
	for (const style of ["rounded", "square"] as const) {
		const others = styles.filter((s) => s !== style);
		if (others.length === 1) return { index: styles.findIndex((s) => s !== style), style };
	}
	return undefined;
}

/** A closed box whose light corners mix ╭ and ┌ styles. Not wrong, but it looks like a slip. */
function checkCorners(grid: Grid, report: Report, box: Box, opened: string): void {
	const cells: [number, number][] = [
		[box.top, box.left],
		[box.top, box.right],
		[box.bottom, box.left],
		[box.bottom, box.right],
	];
	const corners = cells.map(([r, c]) => grid.at(r, c));
	const rounded = corners.filter((ch) => CORNER_STYLES.rounded.includes(ch)).length;
	const square = corners.filter((ch) => CORNER_STYLES.square.includes(ch)).length;
	if (!rounded || !square || rounded + square !== 4) return;
	const odd = oddCorner(corners);
	if (odd) {
		const [r, c] = cells[odd.index]!;
		const ch = corners[odd.index]!;
		report(
			r,
			c,
			"warning",
			`corner ${ch} does not match the other corners of the box (${opened}). Use ${matchingCorner(ch, odd.style)}.`,
		);
	} else
		report(
			box.top,
			box.right,
			"warning",
			`the corners of the box mix ╭ and ┌ styles (${opened}). Use ╭╮╰╯ or ┌┐└┘ for all four.`,
		);
}

/** Rows between the top and bottom of a box where `col` does not carry its side. */
function brokenRows(grid: Grid, box: Box, col: number): number[] {
	const rows: number[] = [];
	for (let r = box.top + 1; r < box.bottom; r++) if (!side(grid.at(r, col))) rows.push(r);
	return rows;
}

/** First row below `top` where column `col` stops carrying a vertical line. */
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

/** Why a side is missing on a row: where its `│` went, and wide characters that pushed it. */
function sideHint(grid: Grid, box: Box, row: number, col: number): string {
	const hints: string[] = [];
	for (let d = 1; d <= 4; d++) {
		const shifted = [col + d, col - d].find((c) => isVertical(grid.at(row, c)) && c !== box.left && c !== box.right);
		if (shifted === undefined) continue;
		const off = shifted - col;
		hints.push(
			` This line's │ is at col ${shifted + 1}, ${Math.abs(off)} col${Math.abs(off) > 1 ? "s" : ""} too far ${off > 0 ? "right" : "left"}.`,
		);
		break;
	}
	const wide = grid.wideIn(row, box.left, Math.max(box.right, col + 5));
	if (wide.length) {
		hints.push(
			` It has wide characters (${[...new Set(wide)].join(" ")}), which take 2 columns each: remove them or drop a space per character.`,
		);
	} else if (hints.length) hints.push(" Pad every line of the box to the same width.");
	if (!hints.length && isBlank(grid.at(row, col))) hints.push(" Draw │ there.");
	return hints.join("");
}

/** A box whose bottom corner on one side is not under its top corner. */
function misaligned(
	grid: Grid,
	report: Report,
	box: Box,
	found: number,
	otherEnd: number,
	opened: string,
	which: "left" | "right",
): void {
	const expected = which === "right" ? box.right : box.left;
	const corner = which === "right" ? "╯" : "╰";
	const topCorner = which === "right" ? "╮" : "╭";
	const sidesAtExpected = otherEnd >= box.bottom;
	const sidesAtFound = run(grid, box.top, found) >= box.bottom;
	const diff = Math.abs(found - expected);
	const cols = `${diff} col${diff > 1 ? "s" : ""}`;
	if (sidesAtExpected || !sidesAtFound) {
		report(
			box.bottom,
			found,
			"error",
			`${corner} is ${cols} off: it must be at col ${expected + 1}, under the ${topCorner} on line ${box.top + 1} (${opened}).`,
		);
	} else {
		report(
			box.top,
			expected,
			"error",
			`${topCorner} is ${cols} off: it must be at col ${found + 1}, above the side and the ${corner} on line ${box.bottom + 1}.`,
		);
	}
}

function explain(explained: Set<string>, box: Box): void {
	for (let r = box.top; r <= box.bottom; r++) {
		explained.add(key(r, box.left));
		explained.add(key(r, box.right));
		for (const c of [box.left - 1, box.left + 1, box.right - 1, box.right + 1]) explained.add(key(r, c));
	}
	for (let c = box.left; c <= box.right; c++) {
		explained.add(key(box.top, c));
		explained.add(key(box.bottom, c));
		explained.add(key(box.top + 1, c));
		explained.add(key(box.bottom - 1, c));
	}
}

/** Corners and junctions must connect on every arm; straight lines must not run into a line without a junction. */
function checkArms(grid: Grid, report: Report): void {
	for (let r = 0; r < grid.height; r++) {
		const row = grid.rows[r]!;
		for (let c = 0; c < row.length; c++) {
			const ch = row[c]!;
			const a = isLine(ch) ? arms(ch) : 0;
			if (!a || popcount(a) < 2) continue;
			const straight = a === (LEFT | RIGHT) || a === (UP | DOWN);
			const empty: number[] = [];
			const wrong: { dir: number; n: string }[] = [];
			for (const dir of DIRECTIONS) {
				if (!(a & dir)) continue;
				const [dr, dc] = STEP[dir]!;
				const n = grid.at(r + dr, c + dc);
				if (arms(n) & OPPOSITE[dir]!) continue;
				const target = key(r + dr, c + dc);
				if (straight) {
					// Dashed lines have no junction characters, so a dashed line meeting a side is fine.
					if (isLine(n) && !arrowDirection(n) && !DASHED.test(ch) && !DASHED.test(n)) {
						report(r, c, "warning", `${ch} runs into ${n} ${NAMES[dir]} without joining it. ${JOIN_HINT[dir]}`, target);
					} else if (
						isBlank(n) &&
						isLine(grid.at(r + 2 * dr, c + 2 * dc)) &&
						!(arms(grid.at(r + 2 * dr, c + 2 * dc)) & OPPOSITE[dir]!)
					) {
						const what = dir === UP || dir === DOWN ? "row" : "col";
						report(r, c, "warning", `${ch} stops 1 ${what} short of the line ${NAMES[dir]}. ${JOIN_HINT[dir]}`, target);
					}
					continue;
				}
				if (isBlank(n)) {
					// `╭ Title ─╮`: a corner followed by a space and a title is a titled edge, not a broken one.
					if ((dir === LEFT || dir === RIGHT) && !isBlank(grid.at(r, c + 2 * dc)) && !isLine(grid.at(r, c + 2 * dc))) {
						continue;
					}
					empty.push(dir);
				} else if (isLine(n)) wrong.push({ dir, n });
			}
			if (empty.length) {
				const where = empty.map((d) => NAMES[d]).join(" or ");
				const hint = empty.length === 1 ? nearby(grid, r, c, empty[0]!) : "";
				report(
					r,
					c,
					"error",
					`${ch} has nothing ${where}.${hint} Extend the line to it, or use a character without that arm.`,
				);
			}
			for (const { dir, n } of wrong) {
				report(
					r,
					c,
					"error",
					`${ch} does not join ${n} ${NAMES[dir]}.${nearby(grid, r, c, dir)} Align them, or use a character that connects.`,
					key(r + STEP[dir]![0], c + STEP[dir]![1]),
				);
			}
		}
	}
}

const JOIN_HINT: Record<number, string> = {
	[UP]: "Make the line above a junction (┬), or leave a row free.",
	[DOWN]: "End it with ▼, or make the line below a junction (┴).",
	[LEFT]: "Start it with ◀, or make the line on the left a junction (├).",
	[RIGHT]: "End it with ▶, or make the line on the right a junction (┤).",
};

/** Where the line the arm should meet actually is, when it is a column or two off. */
function nearby(grid: Grid, r: number, c: number, dir: number): string {
	const [dr, dc] = STEP[dir]!;
	const vertical = dr !== 0;
	for (const d of [1, -1, 2, -2]) {
		const [nr, nc] = vertical ? [r + dr, c + d] : [r + d, c + dc];
		const ch = grid.at(nr, nc);
		const a = arms(ch);
		// Box corners nearby are usually some other box, not the line that was meant.
		if (!(a & OPPOSITE[dir]!) || (popcount(a) === 2 && !isVertical(ch) && !isHorizontal(ch))) continue;
		const n = Math.abs(d);
		const unit = vertical ? `col${n > 1 ? "s" : ""}` : `row${n > 1 ? "s" : ""}`;
		const where = vertical ? (d > 0 ? "right" : "left") : d > 0 ? "lower" : "higher";
		return ` The ${ch} it should meet is ${n} ${unit} ${where}, at line ${nr + 1} col ${nc + 1}.`;
	}
	return "";
}

/** Arrowheads must be fed by their line and touch what they point at. */
function checkArrows(grid: Grid, report: Report): void {
	for (let r = 0; r < grid.height; r++) {
		const row = grid.rows[r]!;
		for (let c = 0; c < row.length; c++) {
			const ch = row[c]!;
			const points = arrowDirection(ch);
			if (!points) continue;
			const [dr, dc] = STEP[points]!;
			const tail = grid.at(r - dr, c - dc);
			const beyond = grid.at(r - 2 * dr, c - 2 * dc);
			if (isBlank(tail) && arms(beyond) & points && isLine(beyond)) {
				report(
					r,
					c,
					"error",
					`gap between the line and ${ch}: remove the space ${NAMES[OPPOSITE[points]!]}.`,
					key(r - dr, c - dc),
				);
			} else if (isLine(tail) && !(arms(tail) & points)) {
				const junction = { [DOWN]: "┬", [UP]: "┴", [RIGHT]: "├", [LEFT]: "┤" }[points];
				report(
					r,
					c,
					"warning",
					`${ch} is not attached to ${tail} ${NAMES[OPPOSITE[points]!]}. Use ${junction} there so the line leaves the border.`,
					key(r - dr, c - dc),
				);
			}
			const tip = grid.at(r + dr, c + dc);
			if (!isBlank(tip)) continue;
			const next = grid.at(r + 2 * dr, c + 2 * dc);
			if (isLine(next)) {
				const what = points === UP || points === DOWN ? "row" : "col";
				report(
					r,
					c,
					"warning",
					`${ch} stops 1 ${what} short of ${next}. Move it so it touches what it points at.`,
					key(r + dr, c + dc),
				);
			} else if (
				(points === DOWN || points === UP) &&
				arms(tail) & points &&
				[1, 2, 3].every((k) => isBlank(grid.at(r + k * dr, c)))
			) {
				report(
					r,
					c,
					"warning",
					`${ch} points at nothing. Put the box or label it points to right ${points === DOWN ? "below" : "above"} it.`,
				);
			}
		}
	}
}

function popcount(n: number): number {
	let count = 0;
	for (let v = n; v; v >>= 1) count += v & 1;
	return count;
}

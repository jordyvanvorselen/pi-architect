import { buildOrder, type Ordered } from "../../plan/order.ts";
import { sliceProblems } from "../../state/queries.ts";
import type { Slice } from "../../state/types.ts";
import { box, clipLine, lineWidth, sp, wrap, wrapAfter, type Line } from "../spans.ts";
import { section, trim, type ReviewBody } from "./common.ts";

const LABEL_WIDTH = 8;

/** `text` after `prefix`, which starts with the rail, and the rail again on every wrapped line. */
function railed(rail: Line, prefix: Line, text: string, width: number, color: "text" | "muted"): Line[] {
	const railWidth = lineWidth(rail);
	return wrapAfter(prefix, text, width, color).map((line, i) => {
		const [lead, ...rest] = line;
		if (i === 0 || !lead || lead.text.trim() || lead.text.length < railWidth) return line;
		return [...rail, sp(lead.text.slice(railWidth)), ...rest];
	});
}

/** `files   a.ts, b.ts` under a slice, behind the rail that links it to the next one. */
function field(rail: Line, label: string, text: string, width: number, color: "text" | "muted"): Line[] {
	return railed(rail, [...rail, sp(label.padEnd(LABEL_WIDTH), "dim")], text, width, color);
}

function sliceLines(
	slice: Slice,
	number: string,
	deps: string[],
	linked: boolean,
	width: number,
	goal: boolean,
): Line[] {
	const rail: Line = [sp(linked ? "│   " : "    ", "borderAccent")];
	const after = deps.length ? [sp("  ← ", "accent"), sp(deps.join(", "), "accent")] : [];
	const head: Line = [sp("● ", "accent"), sp(number, "accent", true), sp("  ")];
	// A long title gives way, so the dependencies after it stay in view.
	const room = width - lineWidth(head) - lineWidth(after);
	const title = room >= 4 ? clipLine([sp(slice.title, "text", true)], room) : [sp(slice.title, "text", true)];
	const lines: Line[] = [clipLine([...head, ...title, ...after], width)];
	if (goal && slice.goal) lines.push(...railed(rail, rail, slice.goal, width, "muted"));
	if (slice.files.length) lines.push(...field(rail, "files", slice.files.join(", "), width, "muted"));
	slice.steps.forEach((step, i) => lines.push(...field(rail, i ? "" : "steps", `${i + 1}. ${step}`, width, "text")));
	if (slice.verify.length)
		slice.verify.forEach((v, i) => lines.push(...field(rail, i ? "" : "verify", v, width, "text")));
	else lines.push([...rail, sp("verify".padEnd(LABEL_WIDTH), "dim"), sp("missing", "warning")]);
	return lines;
}

/**
 * Slices in build order, by the number the plan file and the board give them, with an arrow between a slice
 * and the next one when that one depends on it. `goals` false leaves out the goals, when the screen shows them
 * already.
 */
export function sliceList(order: readonly Ordered[], width: number, goals = true): Line[] {
	if (!order.length) return [[sp("no slices yet", "warning")]];
	const numbers = new Map(order.map((o) => [o.slice.id, String(o.number)]));
	const lines: Line[] = [];
	order.forEach(({ slice, number }, i) => {
		const next = order[i + 1]?.slice;
		const linked = next?.dependsOn.includes(slice.id) ?? false;
		const deps = slice.dependsOn.map((d) => numbers.get(d) ?? d);
		lines.push(...sliceLines(slice, String(number), deps, linked, width, goals));
		if (next) lines.push(linked ? [sp("▼", "borderAccent")] : []);
	});
	return lines;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Columns left of the boxes for `step 1`. Narrower screens put the label above the step. */
const GUTTER = 8;
const BOX_MIN = 22;
const BOX_MAX = 36;
const BOX_GAP = 2;

/** `╭─ 3 ──── ← 1 ─╮`, the title on up to two lines, and what the slice holds. */
function sliceBox(o: Ordered, deps: string[], width: number): Line[] {
	const { slice } = o;
	const room = Math.max(1, width - 4);
	const title = wrap(slice.title, room);
	const lines: Line[] = title
		.slice(0, 2)
		.map((l, i) => [sp(i === 1 && title.length > 2 ? `${l.slice(0, -1)}…` : l, "text", true)]);
	const items = [
		...(slice.files.length ? [sp(plural(slice.files.length, "file"), "muted")] : []),
		...(slice.steps.length ? [sp(plural(slice.steps.length, "step"), "muted")] : []),
		slice.verify.length ? sp(plural(slice.verify.length, "check"), "muted") : sp("no verify", "warning"),
	];
	// The counts wrap between items, never inside one.
	let line: Line = [];
	for (const item of items) {
		if (line.length && lineWidth([...line, sp(" · "), item]) > room) {
			lines.push(line);
			line = [];
		}
		if (line.length) line.push(sp(" · ", "dim"));
		line.push(item);
	}
	lines.push(line);
	return box(lines, width, {
		style: "round",
		color: "borderAccent",
		title: [sp(String(o.number), "accent", true)],
		...(deps.length ? { right: [sp(`← ${deps.join(", ")}`, "accent")] } : {}),
	});
}

/**
 * The build order as a diagram: one row of boxes per build step, an arrow down to the next step. Slices in
 * one step can be built side by side. Each box names what it waits for, like `← 1`.
 */
export function buildDiagram(order: readonly Ordered[], width: number): Line[] {
	if (!order.length) return [[sp("no slices yet", "warning")]];
	const numbers = new Map(order.map((o) => [o.slice.id, String(o.number)]));
	const gutter = width - GUTTER >= BOX_MIN ? GUTTER : 0;
	const room = width - gutter;
	const steps = [...new Set(order.map((o) => o.step))];
	const lines: Line[] = [];
	steps.forEach((step, s) => {
		const group = order.filter((o) => o.step === step);
		const perRow = Math.max(1, Math.min(group.length, Math.floor((room + BOX_GAP) / (BOX_MIN + BOX_GAP))));
		const boxWidth = Math.min(BOX_MAX, Math.floor((room - BOX_GAP * (perRow - 1)) / perRow));
		const label = sp(`step ${step}`.padEnd(gutter), "dim");
		if (!gutter) lines.push([sp(`step ${step}`, "dim")]);
		for (let i = 0; i < group.length; i += perRow) {
			const boxes = group.slice(i, i + perRow).map((o) =>
				sliceBox(
					o,
					o.slice.dependsOn.map((d) => numbers.get(d) ?? d),
					boxWidth,
				),
			);
			const height = Math.max(...boxes.map((b) => b.length));
			for (let r = 0; r < height; r++) {
				const row: Line = gutter ? [r === 0 && i === 0 ? label : sp(" ".repeat(gutter))] : [];
				boxes.forEach((b, n) => {
					if (n) row.push(sp(" ".repeat(BOX_GAP)));
					row.push(...(b[r] ?? [sp(" ".repeat(boxWidth))]));
				});
				lines.push(row);
			}
		}
		if (s < steps.length - 1) lines.push([sp(" ".repeat(gutter + Math.floor(boxWidth / 2))), sp("▼", "borderAccent")]);
	});
	return lines;
}

/**
 * The build order diagram under its heading, with the dependency problems above it, then what each slice
 * delivers.
 */
export function buildOrderSections(order: readonly Ordered[], width: number, problems: readonly string[] = []): Line[] {
	const lines: Line[] = problems.flatMap((problem) => wrapAfter([sp("✗ ", "error")], problem, width, "error"));
	if (lines.length) lines.push([]);
	lines.push(...buildDiagram(order, width));
	const steps = new Set(order.map((o) => o.step)).size;
	const right = order.length ? [sp(`${plural(order.length, "slice")} in ${plural(steps, "step")}`, "dim")] : [];
	const out = section("Build order", lines, width, right);
	const goals = order
		.filter((o) => o.slice.goal)
		.flatMap((o) => wrapAfter([sp(`${o.number} `.padEnd(4), "accent")], o.slice.goal!, width, "text"));
	if (goals.length) out.push(...section("Done when built", goals, width));
	return out;
}

/**
 * Slice: the essence of the plan. The build order as a diagram, then what each slice delivers. The files,
 * steps and verify commands are on the board and in the plan file.
 */
export const sliceBody: ReviewBody = (arch, width) => {
	const out = buildOrderSections(buildOrder(arch.slices), width, sliceProblems(arch.slices));
	if (arch.slices.length)
		out.push(...wrapAfter([], "Files, steps and verify commands are on the board's Slices tab.", width, "dim"));
	return trim(out);
};

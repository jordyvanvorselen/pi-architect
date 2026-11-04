import { buildOrder, type Ordered } from "../../plan/order.ts";
import { sliceProblems } from "../../state/queries.ts";
import type { Slice } from "../../state/types.ts";
import { clipLine, lineWidth, sp, wrapAfter, type Line } from "../spans.ts";
import { risks, section, trim, type ReviewBody } from "./common.ts";

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

function sliceLines(slice: Slice, number: string, deps: string[], linked: boolean, width: number): Line[] {
	const rail: Line = [sp(linked ? "│   " : "    ", "borderAccent")];
	const after = deps.length ? [sp("  ← ", "accent"), sp(deps.join(", "), "accent")] : [];
	const lines: Line[] = [
		clipLine(
			[sp("● ", "accent"), sp(number, "accent", true), sp("  "), sp(slice.title, "text", true), ...after],
			width,
		),
	];
	if (slice.goal) lines.push(...railed(rail, rail, slice.goal, width, "muted"));
	if (slice.files.length) lines.push(...field(rail, "files", slice.files.join(", "), width, "muted"));
	slice.steps.forEach((step, i) => lines.push(...field(rail, i ? "" : "steps", `${i + 1}. ${step}`, width, "text")));
	if (slice.verify.length)
		slice.verify.forEach((v, i) => lines.push(...field(rail, i ? "" : "verify", v, width, "text")));
	else lines.push([...rail, sp("verify".padEnd(LABEL_WIDTH), "dim"), sp("missing", "warning")]);
	return lines;
}

/**
 * Slices in build order, by the number the plan file and the board give them, with an arrow between a slice
 * and the next one when that one depends on it.
 */
export function sliceList(order: readonly Ordered[], width: number): Line[] {
	if (!order.length) return [[sp("no slices yet", "warning")]];
	const numbers = new Map(order.map((o) => [o.slice.id, String(o.number)]));
	const lines: Line[] = [];
	order.forEach(({ slice, number }, i) => {
		const next = order[i + 1]?.slice;
		const linked = next?.dependsOn.includes(slice.id) ?? false;
		const deps = slice.dependsOn.map((d) => numbers.get(d) ?? d);
		lines.push(...sliceLines(slice, String(number), deps, linked, width));
		if (next) lines.push(linked ? [sp("▼", "borderAccent")] : []);
	});
	return lines;
}

/** Slice: the slices in build order, each with its dependencies, files, steps and verify commands. */
export const sliceBody: ReviewBody = (arch, width) => {
	const order = buildOrder(arch.slices);
	const lines: Line[] = [];
	for (const problem of sliceProblems(arch.slices))
		lines.push(...wrapAfter([sp("✗ ", "error")], problem, width, "error"));
	if (lines.length) lines.push([]);
	lines.push(...sliceList(order, width));
	const count = arch.slices.length;
	const right = count ? [sp(`${count} slice${count === 1 ? "" : "s"} · build order`, "dim")] : [];
	return trim([...section("Slices", lines, width, right), ...risks(arch, width)]);
};

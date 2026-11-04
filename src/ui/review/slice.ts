import { sliceProblems } from "../../state/queries.ts";
import type { Slice } from "../../state/types.ts";
import { clipLine, lineWidth, sp, wrapAfter, type Line } from "../spans.ts";
import { risks, section, trim, type ReviewBody } from "./common.ts";

/** Slices in build order: each after the slices it depends on, otherwise in the agent's order. Cycles go last. */
export function sliceOrder(slices: readonly Slice[]): Slice[] {
	const ids = new Set(slices.map((s) => s.id));
	const placed = new Set<string>();
	const order: Slice[] = [];
	let left = [...slices];
	while (left.length) {
		const next = left.find((s) => s.dependsOn.every((d) => d === s.id || !ids.has(d) || placed.has(d)));
		if (!next) {
			order.push(...left);
			break;
		}
		order.push(next);
		placed.add(next.id);
		left = left.filter((s) => s !== next);
	}
	return order;
}

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

function sliceLines(slice: Slice, linked: boolean, width: number): Line[] {
	const rail: Line = [sp(linked ? "│   " : "    ", "borderAccent")];
	const deps = slice.dependsOn.length ? [sp("  ← ", "accent"), sp(slice.dependsOn.join(", "), "accent")] : [];
	const lines: Line[] = [
		clipLine([sp("● ", "accent"), sp(slice.id, "dim"), sp("  "), sp(slice.title, "text", true), ...deps], width),
	];
	if (slice.goal) lines.push(...railed(rail, rail, slice.goal, width, "muted"));
	if (slice.files.length) lines.push(...field(rail, "files", slice.files.join(", "), width, "muted"));
	slice.steps.forEach((step, i) => lines.push(...field(rail, i ? "" : "steps", `${i + 1}. ${step}`, width, "text")));
	if (slice.verify.length)
		slice.verify.forEach((v, i) => lines.push(...field(rail, i ? "" : "verify", v, width, "text")));
	else lines.push([...rail, sp("verify".padEnd(LABEL_WIDTH), "dim"), sp("missing", "warning")]);
	return lines;
}

/** Slices in the given order, an arrow between a slice and the next one when that one depends on it. */
export function sliceList(order: readonly Slice[], width: number): Line[] {
	if (!order.length) return [[sp("no slices yet", "warning")]];
	const lines: Line[] = [];
	order.forEach((slice, i) => {
		const next = order[i + 1];
		const linked = next?.dependsOn.includes(slice.id) ?? false;
		lines.push(...sliceLines(slice, linked, width));
		if (next) lines.push(linked ? [sp("▼", "borderAccent")] : []);
	});
	return lines;
}

/** Slice: the slices in build order, each with its dependencies, files, steps and verify commands. */
export const sliceBody: ReviewBody = (arch, width) => {
	const order = sliceOrder(arch.slices);
	const lines: Line[] = [];
	for (const problem of sliceProblems(arch.slices))
		lines.push(...wrapAfter([sp("✗ ", "error")], problem, width, "error"));
	if (lines.length) lines.push([]);
	lines.push(...sliceList(order, width));
	const count = arch.slices.length;
	const right = count ? [sp(`${count} slice${count === 1 ? "" : "s"} · build order`, "dim")] : [];
	return trim([...section("Slices", lines, width, right), ...risks(arch, width)]);
};

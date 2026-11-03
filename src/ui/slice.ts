import { PHASE_LABEL } from "../state/phases.ts";
import type { SliceDetails, SliceInput } from "../tools/slice.ts";
import type { Paint } from "./paint.ts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `◆ architect slice  4 slices`. Arguments may still be streaming in. */
export function sliceCall(args: Partial<SliceInput> | undefined, paint: Paint): string {
	const title = `${paint.fg("accent", "◆")} ${paint.fg("toolTitle", paint.bold("architect slice"))}`;
	const slices = Array.isArray(args?.slices) ? args.slices : [];
	return slices.length ? `${title}  ${paint.fg("muted", plural(slices.length, "slice"))}` : title;
}

/**
 * The build order, one group per line. Collapsed: the groups with ids. Expanded: titles too, and what
 * changed compared with the earlier list.
 * ```
 * ✓ 4 slices in 3 steps · Slice ready for review
 *   1  s1
 *   2  s2 ∥ s3
 *   3  s4
 * ```
 */
export function sliceResult(
	details: SliceDetails | undefined,
	text: string,
	expanded: boolean,
	isError: boolean,
	paint: Paint,
): string {
	if (isError || !details) return paint.fg(isError ? "error" : "muted", `${isError ? "✗ " : ""}${text}`);
	const count = details.groups.reduce((n, g) => n + g.length, 0);
	const label = PHASE_LABEL[details.phase];
	const state = details.missing.length
		? paint.fg("warning", `${label} needs ${details.missing.join(", ")}`)
		: paint.fg("success", `${label} ready for review`);
	const head = `${paint.fg("success", "✓")} ${paint.fg("muted", `${plural(count, "slice")} in ${plural(details.groups.length, "step")}`)} ${paint.fg("dim", "·")} ${state}`;
	const bar = paint.fg("dim", " ∥ ");
	const lines = details.groups.map((group, i) => {
		const names = group.map((id) =>
			expanded ? `${paint.fg("accent", id)} ${paint.fg("text", details.titles[id] ?? "")}` : paint.fg("accent", id),
		);
		return `  ${paint.fg("dim", String(i + 1).padStart(2))}  ${names.join(bar)}`;
	});
	if (expanded) {
		const delta = [
			details.added.length ? `+ ${details.added.join(", ")}` : "",
			details.changed.length ? `~ ${details.changed.join(", ")}` : "",
			details.removed.length ? `− ${details.removed.join(", ")}` : "",
		].filter(Boolean);
		if (delta.length) lines.push(`  ${paint.fg("dim", delta.join("  "))}`);
	}
	return [head, ...lines].join("\n");
}

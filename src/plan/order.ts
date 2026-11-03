import type { Slice } from "../state/types.ts";

/** One slice in build order. `step` is the group it belongs to; slices in the same group can run in parallel. */
export interface Ordered {
	/** 1-based position in the build order, the number the plan file uses. */
	number: number;
	/** 1-based group. Every dependency is in an earlier group. */
	step: number;
	slice: Slice;
}

/**
 * Slices grouped in build order: the first group has no dependencies, each later group only depends on
 * earlier ones. Within a group the slices keep their input order, so the result is deterministic.
 * Unknown dependencies are ignored. Slices caught in a cycle come last, in one group, so nothing is lost.
 */
export function buildGroups(slices: readonly Slice[]): Slice[][] {
	const ids = new Set(slices.map((s) => s.id));
	const placed = new Set<string>();
	const groups: Slice[][] = [];
	let left = [...slices];
	while (left.length) {
		const ready = left.filter((s) => s.dependsOn.every((d) => d === s.id || !ids.has(d) || placed.has(d)));
		if (!ready.length) {
			groups.push(left);
			break;
		}
		groups.push(ready);
		for (const s of ready) placed.add(s.id);
		left = left.filter((s) => !placed.has(s.id));
	}
	return groups;
}

/** The slices in build order, numbered. */
export function buildOrder(slices: readonly Slice[]): Ordered[] {
	const result: Ordered[] = [];
	buildGroups(slices).forEach((group, i) => {
		for (const slice of group) result.push({ number: result.length + 1, step: i + 1, slice });
	});
	return result;
}

/** `1 → 2, 3 → 4`: the numbers of each group, for one-line summaries. */
export function orderLine(order: readonly Ordered[]): string {
	const groups: number[][] = [];
	for (const o of order) (groups[o.step - 1] ??= []).push(o.number);
	return groups.map((g) => g.join(", ")).join(" → ");
}

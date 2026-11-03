import { PHASE_LABEL, PHASES, phaseIndex, type Phase } from "./phases.ts";
import type { Architecture, PhaseState, Slice } from "./types.ts";

/** How `phase` stands in the architecture: approved, working, in review or pending. */
export function phaseState(arch: Architecture, phase: Phase): PhaseState {
	if (arch.approvedAt !== undefined) return "approved";
	const diff = phaseIndex(phase) - phaseIndex(arch.phase);
	if (diff < 0) return "approved";
	if (diff > 0) return "pending";
	return arch.status;
}

/** The next free id with `prefix`, e.g. "f3" after "f1" and "f2". Never reuses a removed id's number below the max. */
export function nextId(ids: readonly string[], prefix: string): string {
	let max = 0;
	for (const id of ids) {
		if (!id.startsWith(prefix)) continue;
		const n = Number(id.slice(prefix.length));
		if (Number.isInteger(n) && n > max) max = n;
	}
	return `${prefix}${max + 1}`;
}

/** File-name friendly version of a feature name: lower case, words joined by dashes, at most 60 characters. */
export function slugify(feature: string): string {
	const slug = feature
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.slice(0, 60).replace(/-+$/, "") || "feature";
}

export interface Counts {
	open: number;
	decided: number;
	risks: number;
	highRisks: number;
}

export function counts(arch: Architecture): Counts {
	const decided = arch.decisions.filter((d) => d.chosen !== undefined).length;
	return {
		open: arch.decisions.length - decided,
		decided,
		risks: arch.risks.length,
		highRisks: arch.risks.filter((r) => r.severity === "high").length,
	};
}

/** Problems in the slice graph: unknown dependencies, self-dependencies and cycles. */
export function sliceProblems(slices: readonly Slice[]): string[] {
	const problems: string[] = [];
	const ids = new Set(slices.map((s) => s.id));
	for (const slice of slices) {
		for (const dep of slice.dependsOn) {
			if (dep === slice.id) problems.push(`${slice.id} depends on itself`);
			else if (!ids.has(dep)) problems.push(`${slice.id} depends on unknown slice ${dep}`);
		}
	}
	const byId = new Map(slices.map((s) => [s.id, s]));
	const state = new Map<string, "visiting" | "done">();
	const visit = (id: string, path: string[]): string | undefined => {
		if (state.get(id) === "done") return undefined;
		if (state.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id].join(" → ");
		state.set(id, "visiting");
		for (const dep of byId.get(id)?.dependsOn ?? []) {
			if (dep === id || !ids.has(dep)) continue;
			const cycle = visit(dep, [...path, id]);
			if (cycle) return cycle;
		}
		state.set(id, "done");
		return undefined;
	};
	for (const slice of slices) {
		const cycle = visit(slice.id, []);
		if (cycle) {
			problems.push(`cycle ${cycle}`);
			break;
		}
	}
	return problems;
}

/**
 * What the current phase still needs before the user can review it. Empty means ready.
 * The agent gets this list instead of a review screen, so the user is not asked to review half a phase.
 * `has` tells which tools exist: a phase does not require content that no registered tool can add.
 */
export function missing(arch: Architecture, has: (tool: string) => boolean = () => true): string[] {
	const { brief } = arch;
	switch (arch.phase) {
		case "frame":
			return [
				...(arch.feature ? [] : ["a feature name"]),
				...(brief.goal ? [] : ["the goal"]),
				...(brief.doneWhen.length ? [] : ["at least one done-when"]),
			];
		case "explore":
			return arch.modules.some((m) => m.role !== "context") ? [] : ["at least one touched or new module"];
		case "decide": {
			const open = arch.decisions.filter((d) => d.chosen === undefined).map((d) => d.id);
			return open.length ? [`answers to open decisions ${open.join(", ")}`] : [];
		}
		case "design":
			return has("architect_diagram") && !arch.diagrams.some((d) => d.phase === "design")
				? ["at least one diagram"]
				: [];
		case "slice": {
			if (!has("architect_slice")) return [];
			if (!arch.slices.length) return ["at least one slice"];
			const unverified = arch.slices.filter((s) => !s.verify.length).map((s) => s.id);
			return [
				...(unverified.length ? [`a verify step for ${unverified.join(", ")}`] : []),
				...sliceProblems(arch.slices),
			];
		}
		case "blueprint":
			return [];
	}
}

/** "Decide 3/6". */
export function phaseTitle(phase: Phase): string {
	return `${PHASE_LABEL[phase]} ${phaseIndex(phase) + 1}/${PHASES.length}`;
}

import { eventsFrom, type ArchitectEvent, type EntryLike, type UpdateEvent } from "./events.ts";
import { nextPhase } from "./phases.ts";
import type { ArchitectState, Architecture, Brief } from "./types.ts";

/** A new session: build mode, no architecture. */
export const INITIAL_STATE: ArchitectState = { mode: "build" };

export function emptyBrief(): Brief {
	return { goal: "", constraints: [], outOfScope: [], doneWhen: [] };
}

export function newArchitecture(at: number, feature = "", slug = ""): Architecture {
	return {
		feature,
		slug,
		startedAt: at,
		phase: "frame",
		status: "working",
		brief: emptyBrief(),
		modules: [],
		findings: [],
		risks: [],
		decisions: [],
		diagrams: [],
		slices: [],
		reviews: [],
	};
}

/** Replace items with the same key in place, append the others. Keeps the order stable for the UI. */
export function upsert<T>(items: readonly T[], updates: readonly T[], key: (item: T) => string): T[] {
	const result = [...items];
	for (const update of updates) {
		const index = result.findIndex((item) => key(item) === key(update));
		if (index === -1) result.push(update);
		else result[index] = update;
	}
	return result;
}

const byId = (item: { id: string }) => item.id;

function update(arch: Architecture, event: UpdateEvent): Architecture {
	const removed = new Set(event.remove ?? []);
	const keep = <T extends { id: string }>(items: T[]) =>
		removed.size ? items.filter((i) => !removed.has(i.id)) : items;
	const brief = { ...arch.brief };
	for (const key of ["goal", "constraints", "outOfScope", "doneWhen"] as const) {
		const value = event.brief?.[key];
		if (value !== undefined) (brief as Record<typeof key, unknown>)[key] = Array.isArray(value) ? [...value] : value;
	}
	return {
		...arch,
		...(event.feature ? { feature: event.feature.name, slug: event.feature.slug } : {}),
		brief,
		modules: upsert(arch.modules, event.modules ?? [], (m) => m.path).filter((m) => !removed.has(m.path)),
		findings: keep(upsert(arch.findings, event.findings ?? [], byId)),
		risks: keep(upsert(arch.risks, event.risks ?? [], byId)),
		decisions: keep(arch.decisions),
		diagrams: keep(arch.diagrams),
		slices: keep(arch.slices),
	};
}

/** Drop the review summary when the phase leaves review. */
function withoutSubmitted(arch: Architecture): Architecture {
	const { submitted: _submitted, ...rest } = arch;
	return rest;
}

/** Apply a content or gate event to an architecture that is still open. */
function reduceArchitecture(arch: Architecture, event: ArchitectEvent): Architecture {
	switch (event.type) {
		case "update":
			return update(arch, event);
		case "decision":
			return { ...arch, decisions: upsert(arch.decisions, [event.decision], byId) };
		case "choice": {
			const decision = arch.decisions.find((d) => d.id === event.id);
			if (!decision || !decision.options.some((o) => o.id === event.chosen)) return arch;
			const { comment: _comment, ...rest } = decision;
			const chosen = { ...rest, chosen: event.chosen, ...(event.comment ? { comment: event.comment } : {}) };
			return { ...arch, decisions: upsert(arch.decisions, [chosen], byId) };
		}
		case "diagram":
			return { ...arch, diagrams: upsert(arch.diagrams, [event.diagram], byId) };
		case "slices":
			return { ...arch, slices: event.replace ? [...event.slices] : upsert(arch.slices, event.slices, byId) };
		case "submit":
			if (event.phase !== arch.phase) return arch;
			return { ...withoutSubmitted(arch), status: "review", ...(event.summary ? { submitted: event.summary } : {}) };
		case "withdraw":
			if (event.phase !== arch.phase) return arch;
			return { ...withoutSubmitted(arch), status: "working" };
		case "verdict": {
			if (event.phase !== arch.phase) return arch;
			const review = {
				phase: event.phase,
				verdict: event.verdict,
				at: event.at,
				...(event.comment ? { comment: event.comment } : {}),
			};
			const base = { ...withoutSubmitted(arch), status: "working" as const, reviews: [...arch.reviews, review] };
			if (event.verdict === "changes") return base;
			const next = nextPhase(arch.phase);
			return next ? { ...base, phase: next } : { ...base, approvedAt: event.at };
		}
		default:
			return arch;
	}
}

/**
 * Apply one event. Pure: returns a new state and never changes its input.
 * Events that make no sense for the current state (no architecture, a stale phase, an unknown id) change
 * nothing, so a damaged or hand-edited session file cannot break the state.
 */
export function reduce(state: ArchitectState, event: ArchitectEvent): ArchitectState {
	switch (event.type) {
		case "mode": {
			if (event.mode === "build") return { ...state, mode: "build" };
			const keptOff = Array.isArray(event.keptOff)
				? event.keptOff.filter((t) => typeof t === "string")
				: (state.keptOff ?? []);
			return {
				...state,
				mode: "architect",
				architecture: state.architecture ?? newArchitecture(event.at),
				keptOff,
			};
		}
		// A new architecture or a reset keeps the plan: the file is still there, and build mode still builds it.
		case "begin":
			return { ...state, architecture: newArchitecture(event.at, event.feature, event.slug) };
		case "reset": {
			const { architecture: _architecture, ...rest } = state;
			return state.mode === "architect" ? { ...rest, architecture: newArchitecture(event.at) } : rest;
		}
		case "plan": {
			const path = typeof event.path === "string" ? event.path.trim() : "";
			if (!path || typeof event.slug !== "string" || typeof event.at !== "number") return state;
			const feature = typeof event.feature === "string" ? event.feature : "";
			return { ...state, plan: { path, feature, slug: event.slug, at: event.at } };
		}
		default: {
			const arch = state.architecture;
			if (!arch || arch.approvedAt !== undefined) return state;
			const next = reduceArchitecture(arch, event);
			return next === arch ? state : { ...state, architecture: next };
		}
	}
}

/** The state on a branch, rebuilt from its events. */
export function rebuild(entries: readonly EntryLike[]): ArchitectState {
	return eventsFrom(entries).reduce(reduce, INITIAL_STATE);
}

/** True once the user approved the Blueprint. */
export function isApproved(arch: Architecture | undefined): boolean {
	return arch?.approvedAt !== undefined;
}

/** True when the architecture holds nothing worth a confirmation before it is left or discarded. */
export function isPristine(arch: Architecture | undefined): boolean {
	if (!arch) return true;
	const { brief } = arch;
	return (
		arch.phase === "frame" &&
		arch.reviews.length === 0 &&
		!brief.goal &&
		[brief.constraints, brief.outOfScope, brief.doneWhen].every((l) => l.length === 0) &&
		[arch.modules, arch.findings, arch.risks, arch.decisions, arch.diagrams, arch.slices].every((l) => l.length === 0)
	);
}

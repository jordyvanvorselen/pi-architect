import { counts } from "../state/queries.ts";
import type {
	Architecture,
	Brief,
	DecisionOption,
	Diagram,
	Finding,
	Level,
	ModuleRef,
	ModuleRole,
	Risk,
	Severity,
} from "../state/types.ts";
import { buildOrder, sharedFiles, type Ordered, type SharedFile } from "./order.ts";

/**
 * An option as the plan shows it. An option the user wrote has no `rating`: the agent never rated it,
 * and the placeholder numbers in the state must not reach the plan as if they were estimates.
 */
export type BlueprintOption = Omit<DecisionOption, "effort" | "risk" | "byUser"> & {
	rating?: { effort: Level; risk: Level };
	/** The user wrote this option on the decision card. */
	byUser: boolean;
};

/** A decision as the plan shows it: what was chosen, and what was not. */
export interface BlueprintDecision {
	id: string;
	question: string;
	context?: string;
	/** Undefined while the decision is open. An approved plan has none open. */
	chosen?: BlueprintOption;
	/** True when the user picked the option the agent recommended. */
	followedRecommendation: boolean;
	/** The other options, in card order. */
	rejected: { option: BlueprintOption; recommended: boolean }[];
	/** What the user said with the choice. */
	comment?: string;
}

export interface BlueprintCounts {
	modules: number;
	findings: number;
	decisions: number;
	open: number;
	diagrams: number;
	risks: number;
	highRisks: number;
	slices: number;
	/** Groups in the build order. Fewer steps than slices means some can be built in parallel. */
	steps: number;
}

/**
 * Everything the plan file holds, in plan order. The Blueprint review screen and the board render this,
 * and `renderPlan` writes it as markdown, so what the user approves is what the builder reads.
 */
export interface Blueprint {
	feature: string;
	slug: string;
	status: "approved" | "draft";
	approvedAt?: number;
	brief: Brief;
	/** Changed first, then new, then read for context. Input order within a role. */
	modules: ModuleRef[];
	findings: Finding[];
	/** Explore diagrams: how the code looks today. */
	currentShape: Diagram[];
	decisions: BlueprintDecision[];
	/** Design diagrams, and any other diagram not from Explore. */
	design: Diagram[];
	/** High first, then medium, then low. Input order within a severity. */
	risks: Risk[];
	/** Slices in build order, numbered. */
	slices: Ordered[];
	/** Files that slices of one build step both change, so they should not be built at the same time. */
	sharedFiles: SharedFile[];
	counts: BlueprintCounts;
}

const ROLE_ORDER: Record<ModuleRole, number> = { touched: 0, new: 1, context: 2 };
const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Sort without changing the order of equal items, also on engines without a stable sort. */
function stable<T>(items: readonly T[], rank: (item: T) => number): T[] {
	return items
		.map((item, i) => ({ item, i }))
		.sort((a, b) => rank(a.item) - rank(b.item) || a.i - b.i)
		.map((x) => x.item);
}

function option({ effort, risk, byUser, ...rest }: DecisionOption): BlueprintOption {
	return byUser ? { ...rest, byUser: true } : { ...rest, rating: { effort, risk }, byUser: false };
}

function decision(d: Architecture["decisions"][number]): BlueprintDecision {
	const found = d.options.find((o) => o.id === d.chosen);
	const chosen = found && option(found);
	return {
		id: d.id,
		question: d.question,
		...(d.context ? { context: d.context } : {}),
		...(chosen ? { chosen } : {}),
		followedRecommendation: chosen !== undefined && chosen.id === d.recommendation,
		rejected: d.options
			.filter((o) => o.id !== d.chosen)
			.map((o) => ({ option: option(o), recommended: o.id === d.recommendation })),
		...(d.comment ? { comment: d.comment } : {}),
	};
}

const normal = (path: string) => path.trim().replace(/^\.\//, "").replace(/\/+$/, "");

/** Whether a module of the map covers `file`: the module is the file, contains it or lists it. */
function covers(m: ModuleRef, file: string): boolean {
	const path = normal(m.path);
	const f = normal(file);
	return path === f || f.startsWith(`${path}/`) || m.files.some((x) => normal(x) === f || `${path}/${normal(x)}` === f);
}

/** Note on a module the plan adds because a slice touches a file the module map does not have. */
export const ADDED_MODULE_NOTE = "Not in the module map from Explore. The slices create or change these files.";

/** Files the slices touch that no module covers, in slice order. */
export function unmappedFiles(arch: Pick<Architecture, "modules" | "slices">): string[] {
	const files = [...new Set(arch.slices.flatMap((s) => s.files.map(normal)))];
	return files.filter((f) => f && !arch.modules.some((m) => covers(m, f)));
}

/**
 * The module map with every file the slices touch. Files that no module covers are added as new modules,
 * one per directory and with a note, so the builder's context lists every file the plan changes.
 */
function withSliceFiles(arch: Architecture): ModuleRef[] {
	const byDir = new Map<string, string[]>();
	for (const file of unmappedFiles(arch)) {
		const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
		byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
	}
	const added = [...byDir].map(([path, files]): ModuleRef => ({ path, role: "new", files, note: ADDED_MODULE_NOTE }));
	return [...arch.modules, ...added];
}

/** The architecture arranged as the plan. Pure and deterministic. */
export function buildBlueprint(arch: Architecture): Blueprint {
	const slices = buildOrder(arch.slices);
	const modules = withSliceFiles(arch);
	const c = counts(arch);
	return {
		feature: arch.feature,
		slug: arch.slug,
		status: arch.approvedAt !== undefined ? "approved" : "draft",
		...(arch.approvedAt !== undefined ? { approvedAt: arch.approvedAt } : {}),
		brief: arch.brief,
		modules: stable(modules, (m) => ROLE_ORDER[m.role]),
		findings: arch.findings,
		currentShape: arch.diagrams.filter((d) => d.phase === "explore"),
		decisions: arch.decisions.map(decision),
		design: arch.diagrams.filter((d) => d.phase !== "explore"),
		risks: stable(arch.risks, (r) => SEVERITY_ORDER[r.severity]),
		slices,
		sharedFiles: sharedFiles(slices),
		counts: {
			modules: modules.length,
			findings: arch.findings.length,
			decisions: arch.decisions.length,
			open: c.open,
			diagrams: arch.diagrams.length,
			risks: c.risks,
			highRisks: c.highRisks,
			slices: slices.length,
			steps: slices.reduce((max, o) => Math.max(max, o.step), 0),
		},
	};
}

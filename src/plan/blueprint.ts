import { counts } from "../state/queries.ts";
import type {
	Architecture,
	Brief,
	DecisionOption,
	Diagram,
	Finding,
	ModuleRef,
	ModuleRole,
	Risk,
	Severity,
} from "../state/types.ts";
import { buildOrder, type Ordered } from "./order.ts";

/** A decision as the plan shows it: what was chosen, and what was not. */
export interface BlueprintDecision {
	id: string;
	question: string;
	context?: string;
	/** Undefined while the decision is open. An approved plan has none open. */
	chosen?: DecisionOption;
	/** True when the user picked the option the agent recommended. */
	followedRecommendation: boolean;
	/** The other options, in card order. */
	rejected: { option: DecisionOption; recommended: boolean }[];
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
 * Everything the plan file holds, in plan order. The Blueprint review screen and `/board` render this,
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

function decision(d: Architecture["decisions"][number]): BlueprintDecision {
	const chosen = d.options.find((o) => o.id === d.chosen);
	return {
		id: d.id,
		question: d.question,
		...(d.context ? { context: d.context } : {}),
		...(chosen ? { chosen } : {}),
		followedRecommendation: chosen !== undefined && chosen.id === d.recommendation,
		rejected: d.options
			.filter((o) => o.id !== d.chosen)
			.map((option) => ({ option, recommended: option.id === d.recommendation })),
		...(d.comment ? { comment: d.comment } : {}),
	};
}

/** The architecture arranged as the plan. Pure and deterministic. */
export function buildBlueprint(arch: Architecture): Blueprint {
	const slices = buildOrder(arch.slices);
	const c = counts(arch);
	return {
		feature: arch.feature,
		slug: arch.slug,
		status: arch.approvedAt !== undefined ? "approved" : "draft",
		...(arch.approvedAt !== undefined ? { approvedAt: arch.approvedAt } : {}),
		brief: arch.brief,
		modules: stable(arch.modules, (m) => ROLE_ORDER[m.role]),
		findings: arch.findings,
		currentShape: arch.diagrams.filter((d) => d.phase === "explore"),
		decisions: arch.decisions.map(decision),
		design: arch.diagrams.filter((d) => d.phase !== "explore"),
		risks: stable(arch.risks, (r) => SEVERITY_ORDER[r.severity]),
		slices,
		counts: {
			modules: arch.modules.length,
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

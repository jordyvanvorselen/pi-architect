import type { Phase } from "./phases.ts";

/**
 * Status of the current phase. Phases before it are approved, phases after it are pending.
 * `review` means the agent called `architect_advance` and the user has not answered yet.
 */
export type PhaseStatus = "working" | "review";

/** How a phase looks from the outside, for the stepper and the board. */
export type PhaseState = "approved" | PhaseStatus | "pending";

/** Frame: what the feature is and when it is done. */
export interface Brief {
	goal: string;
	constraints: string[];
	outOfScope: string[];
	doneWhen: string[];
}

/** `touched`: existing code that changes. `new`: code that does not exist yet. `context`: read, not changed. */
export type ModuleRole = "touched" | "new" | "context";

/** Explore: one module (directory, package or file group) of the module map. Keyed by `path`. */
export interface ModuleRef {
	path: string;
	role: ModuleRole;
	files: string[];
	note?: string;
}

/** Explore: one key finding about the existing code. */
export interface Finding {
	id: string;
	text: string;
}

export type Severity = "low" | "medium" | "high";

export interface Risk {
	id: string;
	text: string;
	severity: Severity;
	mitigation?: string;
}

/** 1 (low) to 5 (high). */
export type Level = 1 | 2 | 3 | 4 | 5;

export interface DecisionOption {
	/** Letter shown on the card, e.g. "A". */
	id: string;
	title: string;
	summary?: string;
	pros: string[];
	cons: string[];
	effort: Level;
	risk: Level;
	/** The user wrote this option on the decision card. The agent did not rate its effort and risk. */
	byUser?: boolean;
}

/** Decide: one open question. Open while `chosen` is undefined. */
export interface Decision {
	id: string;
	question: string;
	context?: string;
	options: DecisionOption[];
	/** Option id the agent recommends. */
	recommendation?: string;
	/** Why the agent recommends it, in one line. */
	reason?: string;
	/** Option id the user picked. */
	chosen?: string;
	/** What the user said with the choice, e.g. "Pick B, but only for alarms". */
	comment?: string;
}

/**
 * Explore or Design: one Unicode diagram the agent drew. Fits `Diagram` from `src/diagram/types.ts`
 * (`title`, `body`, `caption`) plus the id and the phase it belongs to. `[new]`, `[changed]` and `[removed]`
 * markers in the body are highlighted when it is shown.
 */
export interface Diagram {
	id: string;
	phase: Phase;
	title: string;
	body: string;
	caption?: string;
}

/** Slice: one buildable piece of work. */
export interface Slice {
	id: string;
	title: string;
	/** What is true once the slice is built, in one sentence. */
	goal?: string;
	/** Ids of slices that must be built first. */
	dependsOn: string[];
	files: string[];
	steps: string[];
	/** Commands or tests that prove the slice is done. */
	verify: string[];
}

export type Verdict = "approved" | "changes";

/** One answer at a phase gate. */
export interface Review {
	phase: Phase;
	verdict: Verdict;
	comment?: string;
	at: number;
}

/**
 * `architect`: read-only, the agent walks through the phases. `build`: normal Pi.
 * The user sets it; it is stored per session.
 */
export type Mode = "architect" | "build";

/** The design of one feature, from the first Frame to the approved Blueprint. */
export interface Architecture {
	/** Short feature name. Empty until the user or the agent names it. */
	feature: string;
	/** File-name friendly feature name, e.g. "dedupe-panel-events". */
	slug: string;
	startedAt: number;
	phase: Phase;
	status: PhaseStatus;
	/** What the agent asked the reviewer to check, while `status` is `review`. */
	submitted?: string;
	brief: Brief;
	modules: ModuleRef[];
	findings: Finding[];
	risks: Risk[];
	decisions: Decision[];
	diagrams: Diagram[];
	slices: Slice[];
	reviews: Review[];
	/** When the user approved the Blueprint. The architecture is final from then on. */
	approvedAt?: number;
}

/** The plan file this session builds from. Set when the plan is written, or when a build session is handed one. */
export interface PlanRef {
	/** Relative to the session's cwd when the file is inside it, absolute otherwise. */
	path: string;
	feature: string;
	slug: string;
	at: number;
}

/** Everything pi-architect keeps per session, rebuilt from the branch. */
export interface ArchitectState {
	mode: Mode;
	/** Undefined until the user first enters architect mode, and after a reset in build mode. */
	architecture?: Architecture;
	/** The plan file, once written. A new architecture or a reset keeps it: the file is still there to build. */
	plan?: PlanRef;
	/**
	 * Tools architect mode turned off since the user last entered it. Build mode turns exactly these back on.
	 * Undefined while the session was never in architect mode, so build mode leaves the tools alone.
	 */
	turnedOff?: string[];
}

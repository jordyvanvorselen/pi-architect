import type { Phase } from "./phases.ts";
import type {
	Brief,
	Decision,
	DecisionOption,
	Diagram,
	Finding,
	Mode,
	ModuleRef,
	Risk,
	Slice,
	Verdict,
} from "./types.ts";

/** `customType` of every session entry pi-architect appends. */
export const ENTRY_TYPE = "architect";

/** Bump when an event changes shape, and teach `parseEvent` the old one. */
export const EVENT_VERSION = 1;

/**
 * Every change is one of these events, appended with `pi.appendEntry(ENTRY_TYPE, event)`.
 * The state is rebuilt from the events on the current branch, so a fork in the session tree is a what-if branch.
 * Events carry their own ids so that replaying them always gives the same state.
 */
export type ArchitectEvent =
	| ModeEvent
	| BeginEvent
	| ResetEvent
	| UpdateEvent
	| DecisionEvent
	| ChoiceEvent
	| DiagramEvent
	| SlicesEvent
	| SubmitEvent
	| WithdrawEvent
	| VerdictEvent
	| PlanEvent;

interface Base {
	v: typeof EVENT_VERSION;
}

/** The user switched mode. Entering architect mode without an architecture starts an empty one. */
export interface ModeEvent extends Base {
	type: "mode";
	mode: Mode;
	at: number;
}

/** `/architect <feature>`: a new architecture for a named feature. Replaces any earlier one. */
export interface BeginEvent extends Base {
	type: "begin";
	feature: string;
	slug: string;
	at: number;
}

/** `/architect reset`: discard the architecture. In architect mode a fresh, empty one takes its place. */
export interface ResetEvent extends Base {
	type: "reset";
	at: number;
}

/** `architect_update`: phase content. Lists in `brief` replace the old list; the rest upserts by id or path. */
export interface UpdateEvent extends Base {
	type: "update";
	phase: Phase;
	/** Names the feature when the user did not. */
	feature?: { name: string; slug: string };
	brief?: Partial<Brief>;
	modules?: ModuleRef[];
	findings?: Finding[];
	risks?: Risk[];
	/** Finding, risk, decision, diagram or slice ids, or module paths. */
	remove?: string[];
}

/** A decision raised, or replaced by id. */
export interface DecisionEvent extends Base {
	type: "decision";
	decision: Decision;
}

/**
 * What the transcript card of a choice shows, as it was when the user chose. The agent can later replace
 * the decision under the same id, so the card must not look the decision up again.
 */
export interface ChoiceSnapshot {
	question: string;
	recommendation?: string;
	options: Pick<DecisionOption, "id" | "title" | "effort" | "risk" | "byUser">[];
}

/** The user picked an option. */
export interface ChoiceEvent extends Base {
	type: "choice";
	id: string;
	chosen: string;
	comment?: string;
	/** Missing in events from before snapshots; the card then looks the decision up in the current state. */
	snapshot?: ChoiceSnapshot;
}

/** The parts of a decision a choice card needs, to store with the choice. */
export function choiceSnapshot(decision: Decision): ChoiceSnapshot {
	return {
		question: decision.question,
		...(decision.recommendation ? { recommendation: decision.recommendation } : {}),
		options: decision.options.map((o) => ({
			id: o.id,
			title: o.title,
			effort: o.effort,
			risk: o.risk,
			...(o.byUser ? { byUser: true } : {}),
		})),
	};
}

/** A diagram added, or replaced by id. */
export interface DiagramEvent extends Base {
	type: "diagram";
	diagram: Diagram;
}

/** Slices added or replaced by id. With `replace`, the list replaces all slices. */
export interface SlicesEvent extends Base {
	type: "slices";
	slices: Slice[];
	replace?: boolean;
}

/** `architect_advance`: the agent asks the user to review the current phase. */
export interface SubmitEvent extends Base {
	type: "submit";
	phase: Phase;
	summary?: string;
	at: number;
}

/** The review closed without a decision, e.g. the user pressed Escape. The phase goes back to working. */
export interface WithdrawEvent extends Base {
	type: "withdraw";
	phase: Phase;
	at: number;
}

/**
 * The user's answer at the gate. `approved` moves to the next phase; approving the Blueprint makes the
 * architecture final. `changes` sends the agent back to work on the same phase.
 */
export interface VerdictEvent extends Base {
	type: "verdict";
	phase: Phase;
	verdict: Verdict;
	comment?: string;
	at: number;
}

/**
 * The plan file was written after the Blueprint was approved, or a new build session was handed it.
 * `path` is relative to the session's cwd when the file is inside it.
 */
export interface PlanEvent extends Base {
	type: "plan";
	path: string;
	feature: string;
	slug: string;
	at: number;
}

/** Distributes `Omit` over the union, so each variant keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event without the version field. */
export type EventInput = DistributiveOmit<ArchitectEvent, "v">;

/** Stamp the version on an event before it is appended. */
export function event(input: EventInput): ArchitectEvent {
	return { v: EVENT_VERSION, ...input } as ArchitectEvent;
}

const TYPES = new Set<string>([
	"mode",
	"begin",
	"reset",
	"update",
	"decision",
	"choice",
	"diagram",
	"slices",
	"submit",
	"withdraw",
	"verdict",
	"plan",
]);

/** The event in entry data, or `undefined` when the data is not one this version understands. */
export function parseEvent(data: unknown): ArchitectEvent | undefined {
	if (!data || typeof data !== "object") return undefined;
	const candidate = data as { v?: unknown; type?: unknown };
	if (candidate.v !== EVENT_VERSION || typeof candidate.type !== "string" || !TYPES.has(candidate.type))
		return undefined;
	return data as ArchitectEvent;
}

/** The shape of session entries this module reads. Pi's `SessionEntry` fits it. */
export interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Architect events on a branch, oldest first. */
export function eventsFrom(entries: readonly EntryLike[]): ArchitectEvent[] {
	const events: ArchitectEvent[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const parsed = parseEvent(entry.data);
		if (parsed) events.push(parsed);
	}
	return events;
}

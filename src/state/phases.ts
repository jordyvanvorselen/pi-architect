/** The phases of an architecture session, in the order the agent must visit them. */
export const PHASES = ["frame", "explore", "decide", "design", "slice", "blueprint"] as const;

export type Phase = (typeof PHASES)[number];

/** Names for the stepper, the review screen and the prompt. */
export const PHASE_LABEL: Record<Phase, string> = {
	frame: "Frame",
	explore: "Explore",
	decide: "Decide",
	design: "Design",
	slice: "Slice",
	blueprint: "Blueprint",
};

/** Three-letter names for narrow terminals. */
export const PHASE_SHORT: Record<Phase, string> = {
	frame: "Frm",
	explore: "Exp",
	decide: "Dec",
	design: "Dsn",
	slice: "Slc",
	blueprint: "Bpt",
};

export function isPhase(value: unknown): value is Phase {
	return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

/** Zero-based position of `phase`. */
export function phaseIndex(phase: Phase): number {
	return PHASES.indexOf(phase);
}

/** The phase after `phase`, or `undefined` when `phase` is the last one. */
export function nextPhase(phase: Phase): Phase | undefined {
	return PHASES[phaseIndex(phase) + 1];
}

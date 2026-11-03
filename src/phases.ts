/** The phases of an architecture session, in the order the agent must visit them. */
export const PHASES = ["frame", "explore", "decide", "design", "slice"] as const;

export type Phase = (typeof PHASES)[number];

/** The phase after `phase`, or `undefined` when `phase` is the last one. */
export function nextPhase(phase: Phase): Phase | undefined {
	return PHASES[PHASES.indexOf(phase) + 1];
}

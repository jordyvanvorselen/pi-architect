/** How long after a decision card or review screen opens its action keys are ignored, in milliseconds. */
export const GRACE_MS = 300;

export interface GraceOptions {
	/** The clock. Default `Date.now`. Tests pass their own. */
	now?: () => number;
	/** Length of the grace period. Default `GRACE_MS`; 0 turns it off. */
	graceMs?: number;
}

/**
 * A short grace period after a screen opens. A ↵ the user meant for the chat editor can land on a card
 * that opened a moment earlier, and there it would choose or approve. During the grace period the screen
 * ignores ↵ and the other keys that choose, approve or open an editor. Navigation keys still work.
 *
 * There is no visual cue. The period is shorter than a deliberate keypress takes, so a cue would only
 * flicker on every open. A ↵ that gets ignored needs one more press, and does no harm.
 */
export class InputGrace {
	private readonly now: () => number;
	private readonly until: number;

	constructor({ now = Date.now, graceMs = GRACE_MS }: GraceOptions = {}) {
		this.now = now;
		this.until = now() + graceMs;
	}

	/** True while action keys must be ignored. */
	get active(): boolean {
		return this.now() < this.until;
	}
}

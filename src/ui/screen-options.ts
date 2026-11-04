import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GraceOptions } from "./grace.ts";

/** Options of a decision card or review screen. */
export interface ScreenOptions extends GraceOptions {
	/**
	 * Opens the board over the screen. The `b` key calls it, also during the grace period. The screen keeps
	 * its state, so closing the board returns to it as it was. Without it there is no `b` key.
	 */
	board?: () => void;
}

/** Options of the decision card and review screen factories. */
export interface ScreenUiOptions extends GraceOptions {
	/** Opens the board over the card or screen, read-only. */
	board?: (ctx: ExtensionContext) => void;
}

/** The screen options for one card or screen shown in `ctx`. */
export function screenOptions({ board, ...grace }: ScreenUiOptions, ctx: ExtensionContext): ScreenOptions {
	return board ? { ...grace, board: () => board(ctx) } : grace;
}

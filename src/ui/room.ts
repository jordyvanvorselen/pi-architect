import type { Component, TUI } from "@earendil-works/pi-tui";

/** Transcript rows an inline screen leaves in view above it. */
export const TRANSCRIPT_ROWS = 2;

/**
 * Rows Pi's own chrome takes when it cannot be measured: the loader while the agent works (2), the widget
 * above the editor with its spacer (2) and the footer (3).
 */
export const FALLBACK_CHROME = 7;

/**
 * Rows an inline screen in the editor slot may use without pushing Pi's chrome or itself off screen.
 *
 * Pi stacks the transcript, pending messages, the loader, the widgets, the editor slot and the footer. In
 * fullscreen mode the editor slot shrinks from the bottom when the stack is taller than the terminal, which
 * cut off the screen's bottom border; in the normal mode the top scrolls away instead. So this measures the
 * rows the other parts take right now, at the same width, and keeps `TRANSCRIPT_ROWS` of transcript.
 * The first child of the TUI is the transcript. Where the screen is not found among the TUI's children,
 * as in tests, it assumes `FALLBACK_CHROME`.
 */
export function inlineRoom(tui: TUI, self: Component, width: number): number {
	const rows = tui.terminal.rows;
	const children: readonly Component[] = tui.children ?? [];
	const slot = children.findIndex(
		(c) => c === self || ((c as { children?: unknown }).children as Component[] | undefined)?.includes(self),
	);
	if (slot < 0) return rows - TRANSCRIPT_ROWS - FALLBACK_CHROME;
	let chrome = 0;
	children.forEach((child, i) => {
		if (i !== 0 && i !== slot) chrome += child.render(width).length;
	});
	return rows - TRANSCRIPT_ROWS - chrome;
}

// Status markers the model puts after a label: `Deduper [new]`. The renderer colours the label and its box.
import type { Grid } from "./grid.ts";

export const STATUSES = ["new", "changed", "removed"] as const;
export type Status = (typeof STATUSES)[number];

/** Words models reach for instead of the real markers, and the marker they mean. */
export const MARKER_ALIASES: Record<string, string> = {
	added: "[new]",
	add: "[new]",
	created: "[new]",
	modified: "[changed]",
	updated: "[changed]",
	edited: "[changed]",
	deleted: "[removed]",
	dropped: "[removed]",
	existing: "no marker (unmarked parts read as existing)",
	unchanged: "no marker (unmarked parts read as existing)",
};

export interface Marker {
	status: Status;
	row: number;
	/** First and last column of the `[…]` text. */
	start: number;
	end: number;
}

/** Every `[new]`, `[changed]` and `[removed]` in the grid. */
export function findMarkers(grid: Grid): Marker[] {
	const out: Marker[] = [];
	for (let row = 0; row < grid.height; row++) {
		const cells = grid.rows[row]!;
		for (let col = 0; col < cells.length; col++) {
			if (cells[col] !== "[") continue;
			for (const status of STATUSES) {
				const text = `[${status}]`;
				if ([...text].every((ch, i) => cells[col + i] === ch)) {
					out.push({ status, row, start: col, end: col + text.length - 1 });
				}
			}
		}
	}
	return out;
}

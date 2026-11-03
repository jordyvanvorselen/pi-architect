import { SLICES_HEADING } from "./render.ts";

/** One slice of a plan file and how many of its boxes are ticked. */
export interface SliceProgress {
	number: number;
	title: string;
	/** Checkboxes in the slice: its steps and "Verified". */
	total: number;
	checked: number;
}

export type SliceState = "done" | "active" | "pending";

const HEADING = /^### (\d+)\.\s+(.+?)\s*#*\s*$/;
const BOX = /^\s*[-*+]\s+\[([ xX])\]\s/;
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * The slices of a plan file with their ticked boxes, read from `## Slices`. The builder ticks the boxes, so
 * the file is the one place progress lives: it works in any session, and in any tool that edits markdown.
 * Boxes inside fenced code are ignored. Returns an empty list when the file has no slices section.
 */
export function parsePlanProgress(markdown: string): SliceProgress[] {
	const result: SliceProgress[] = [];
	let inSlices = false;
	let fence: string | undefined;
	let current: SliceProgress | undefined;
	for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
		const f = FENCE.exec(line)?.[1];
		if (fence) {
			if (f && f[0] === fence[0] && f.length >= fence.length && !line.trim().slice(f.length)) fence = undefined;
			continue;
		}
		if (f) {
			fence = f;
			continue;
		}
		if (/^##\s/.test(line)) {
			inSlices = line.trim() === SLICES_HEADING;
			current = undefined;
			continue;
		}
		if (!inSlices) continue;
		const heading = HEADING.exec(line);
		if (heading) {
			current = { number: Number(heading[1]), title: heading[2]!, total: 0, checked: 0 };
			result.push(current);
			continue;
		}
		const box = BOX.exec(line);
		if (box && current) {
			current.total++;
			if (box[1] !== " ") current.checked++;
		}
	}
	return result;
}

/** Done when every box is ticked. Active when some are, or when it is the first slice not done. */
export function sliceStates(slices: readonly SliceProgress[]): SliceState[] {
	const first = slices.findIndex((s) => !isDone(s));
	return slices.map((s, i) => (isDone(s) ? "done" : i === first || s.checked > 0 ? "active" : "pending"));
}

export const isDone = (s: SliceProgress) => s.total > 0 && s.checked === s.total;

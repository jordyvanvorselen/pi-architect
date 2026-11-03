// Width-aware text helpers. Every width is measured in terminal columns with pi-tui's `visibleWidth`.
import { visibleWidth } from "@earendil-works/pi-tui";

const segmenter = new Intl.Segmenter();
// eslint-disable-next-line no-control-regex -- control characters would break the cell grid
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/** One line of plain text: control characters and line breaks become spaces, runs of spaces collapse. */
export function clean(text: string): string {
	return text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

/** The graphemes of `text` with their column widths. Zero-width graphemes are dropped. */
export function graphemes(text: string): { g: string; w: number }[] {
	const out: { g: string; w: number }[] = [];
	for (const { segment } of segmenter.segment(text)) {
		const w = visibleWidth(segment);
		if (w > 0) out.push({ g: segment, w });
	}
	return out;
}

export const width = visibleWidth;

/** Cut to `max` columns, ending in `…` when something was cut. */
export function truncate(text: string, max: number): string {
	if (max <= 0) return "";
	if (visibleWidth(text) <= max) return text;
	return `${splitAt(text, max - 1)[0].trimEnd()}…`;
}

/**
 * Word-wrap `text` into at most `maxLines` lines of at most `max` columns. Words longer than a line are broken;
 * text that does not fit in `maxLines` ends in `…`. Explicit `\n` in the text starts a new line.
 */
export function wrap(text: string, max: number, maxLines = 3): string[] {
	const limit = Math.max(1, max);
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		let line = "";
		for (const word of clean(paragraph).split(" ").filter(Boolean)) {
			const candidate = line ? `${line} ${word}` : word;
			if (visibleWidth(candidate) <= limit) {
				line = candidate;
				continue;
			}
			if (line) lines.push(line);
			line = word;
			while (visibleWidth(line) > limit) {
				const [head, rest] = splitAt(line, limit);
				lines.push(head);
				line = rest;
			}
		}
		if (line) lines.push(line);
	}
	if (lines.length === 0) return [""];
	if (lines.length <= maxLines) return lines;
	const kept = lines.slice(0, maxLines);
	const last = kept[maxLines - 1] ?? "";
	kept[maxLines - 1] = visibleWidth(last) + 1 <= limit ? `${last}…` : truncate(`${last}…`, limit);
	return kept;
}

/** The first `max` columns of `text`, and the rest. Never splits a grapheme. */
function splitAt(text: string, max: number): [string, string] {
	let used = 0;
	let head = "";
	const parts = graphemes(text);
	let i = 0;
	for (; i < parts.length; i++) {
		const part = parts[i];
		if (!part || used + part.w > max) break;
		head += part.g;
		used += part.w;
	}
	return [
		head,
		parts
			.slice(i)
			.map((p) => p.g)
			.join(""),
	];
}

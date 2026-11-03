// How to draw a diagram the linter accepts and the renderer shows well. Injected into the model's instructions.
import { DEFAULT_MAX_WIDTH } from "./validate.ts";

/** The example in the guide. Tests keep it free of findings. */
export const GUIDE_EXAMPLE = [
	"╭───────╮  events  ╭─────────────────────╮  dedupe  ╭─────────────╮",
	"│ Panel ├─────────▶│ Processor [changed] ├┄┄┄┄┄┄┄┄┄▶│ Redis [new] │",
	"╰───────╯          ╰──────────┬──────────╯          ╰─────────────╯",
	"                              │ HTTP",
	"                              ▼",
	"                     ╭─────────────────╮",
	"                     │   Backend API   │",
	"                     ╰─────────────────╯",
].join("\n");

/** Drawing rules for the model, matching exactly what `validateDiagram` checks. */
export function diagramGuide(maxWidth = DEFAULT_MAX_WIDTH): string {
	return [
		"Draw diagrams yourself as Unicode text. Pick whatever layout shows the idea most clearly.",
		"- Boxes: ╭───╮ │ x │ ╰───╯. Every line of a box is the same width, so each side stays in one column.",
		"- Count columns, not characters. Avoid emoji and CJK inside boxes: they take 2 columns each.",
		"- Lines: ─ and │, dashed ┄ and ┆ for async or events. Arrowheads ▶ ◀ ▼ ▲ touch what they point at.",
		"- Where a line leaves a border or joins another line, draw the junction (├ ┤ ┬ ┴ ┼), e.g. ╰──┬──╯ above a line down.",
		"- Every corner and junction arm must reach a line. No gaps between a line and its arrowhead.",
		"- Label edges with a word or two next to the line: ──reads──▶, or │ HTTP beside a vertical line.",
		"- Groups: a titled frame around related boxes, ╭─ Backend ───╮ … ╰─────────────╯. Lines crossing a frame use ┼.",
		"- Mark what this feature touches: Name [new], Name [changed], Name [removed]. Unmarked parts read as existing.",
		`- At most ${maxWidth} columns wide and about 40 lines tall. Stack boxes top to bottom when it gets wide.`,
		"- Spaces only: no tabs, no colour codes. One idea per diagram; split big ones.",
		"Example:",
		GUIDE_EXAMPLE,
		"If the diagram is rejected, fix every finding at the line and column given and send the whole diagram again.",
	].join("\n");
}

/** The guide for the default width. */
export const DIAGRAM_GUIDE = diagramGuide();

import { renderDiagram, type Diagram, type DiagramTheme, type RenderOptions } from "../diagram/index.ts";
import { wrap } from "../diagram/text.ts";

/** Columns the caption is indented under the diagram, in line with the card's content. */
const CAPTION_INDENT = 2;
/** Lines a caption may take before it ends in `…`. */
const CAPTION_LINES = 6;

/**
 * A diagram for a review screen, the board or the transcript: the drawing in its card, and the caption under
 * the card at the full `width`. Inside the card the caption would wrap at the drawing's width, often 48
 * columns, and leave the rest of a wide screen empty.
 */
export function captionedDiagram(d: Diagram, width: number, theme: DiagramTheme, options?: RenderOptions): string[] {
	const { caption, ...drawing } = d;
	const lines = renderDiagram(drawing, width, theme, options);
	const text = caption?.trim();
	if (!text) return lines;
	const indent = width > 20 ? CAPTION_INDENT : 0;
	const pad = " ".repeat(indent);
	return [...lines, ...wrap(text, width - indent, CAPTION_LINES).map((line) => pad + theme.fg("dim", line))];
}

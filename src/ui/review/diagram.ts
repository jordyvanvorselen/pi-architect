import type { Diagram } from "../../state/types.ts";
import { captionedDiagram } from "../captioned.ts";
import type { Paint } from "../paint.ts";
import { raw, type Line } from "../spans.ts";

const PLAIN: Paint = { fg: (_color, text) => text, bold: (text) => text };

/**
 * One diagram as review lines, drawn by the diagram renderer. It lays out from measured plain text, so the
 * plain render gives each themed line's width.
 */
export function diagramLines(diagram: Diagram, width: number, paint: Paint): Line[] {
	const d = { title: diagram.title, body: diagram.body, ...(diagram.caption ? { caption: diagram.caption } : {}) };
	const plain = captionedDiagram(d, width, PLAIN);
	const styled = captionedDiagram(d, width, paint);
	return styled.map((line, i) => [raw(line, plain[i] ?? "")]);
}

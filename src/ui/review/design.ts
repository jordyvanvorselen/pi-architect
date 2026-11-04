import { sp, type Line } from "../spans.ts";
import { section, trim, type ReviewBody } from "./common.ts";
import { diagramLines } from "./diagram.ts";

/** Design: every design diagram, with new, changed and removed parts highlighted. */
export const designBody: ReviewBody = (arch, width, paint) => {
	const diagrams = arch.diagrams.filter((d) => d.phase === "design");
	const count = diagrams.length;
	const body: Line[] = count
		? diagrams.flatMap((d, i) => [...(i ? [[]] : []), ...diagramLines(d, width, paint)])
		: [[sp("No diagrams. The design is in the decisions and the chat.", "muted")]];
	const right = count ? [sp(`${count} diagram${count === 1 ? "" : "s"}`, "dim")] : [];
	return trim(section("Diagrams", body, width, right));
};

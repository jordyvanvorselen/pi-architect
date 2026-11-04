import { sp } from "../spans.ts";
import { bullets, halves, pair, paragraph, section, trim, type ReviewBody } from "./common.ts";

/** Frame: the brief as a card. Goal, then constraints beside out of scope, then done-when as a checklist. */
export const frameBody: ReviewBody = (arch, width) => {
	const { brief } = arch;
	const lines = section(
		"Goal",
		brief.goal ? paragraph(brief.goal, width, "text", true) : [[sp("not set", "warning")]],
		width,
	);
	const [left, right] = halves(width);
	lines.push(
		...pair(
			trim(section("Constraints", bullets(brief.constraints, left), left)),
			trim(section("Out of scope", bullets(brief.outOfScope, right, "×", "dim", "muted"), right)),
			width,
		),
		[],
	);
	lines.push(...section("Done when", bullets(brief.doneWhen, width, "☐", "success"), width));
	return trim(lines);
};

import { buildBlueprint } from "../../plan/blueprint.ts";
import { lineWidth, pathAfter, sp, wrapAfter, type Line, type Span } from "../spans.ts";
import { bullets, halves, pair, paragraph, risks, section, trim, type ReviewBody } from "./common.ts";
import { decisionLines } from "./decide.ts";
import { diagramLines } from "./diagram.ts";
import { legend, moduleMap } from "./explore.ts";
import { sliceList } from "./slice.ts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `4 modules · 3 decisions · 2 diagrams · 4 slices in 3 steps · ⚠ 2 risks`, wrapped at the separators. */
function summary(counts: ReturnType<typeof buildBlueprint>["counts"], width: number): Line[] {
	const items: Span[][] = [
		[sp(plural(counts.modules, "module"), "text")],
		[sp(plural(counts.decisions, "decision"), "text")],
		...(counts.open ? [[sp(`${counts.open} open`, "warning")]] : []),
		[sp(plural(counts.diagrams, "diagram"), "text")],
		[
			sp(plural(counts.slices, "slice"), "text"),
			...(counts.slices && counts.steps < counts.slices ? [sp(` in ${plural(counts.steps, "step")}`, "muted")] : []),
		],
		...(counts.risks ? [[sp(`⚠ ${plural(counts.risks, "risk")}`, counts.highRisks ? "error" : "warning")]] : []),
	];
	const lines: Line[] = [];
	let line: Line = [];
	let used = 0;
	for (const item of items) {
		const w = lineWidth(item);
		if (line.length && used + 3 + w > width) {
			lines.push(line);
			line = [];
			used = 0;
		}
		if (line.length) {
			line.push(sp(" · ", "dim"));
			used += 3;
		}
		line.push(...item);
		used += w;
	}
	lines.push(line);
	return lines;
}

/**
 * Blueprint: the whole design on one page, in the order of the plan file. Where approving writes the
 * file, the counts, the brief, the module map, the decisions, the design diagrams, the slices in build
 * order and the risks.
 */
export const blueprintBody: ReviewBody = (arch, width, paint, request) => {
	const bp = buildBlueprint(arch);
	const lines: Line[] = [];
	lines.push(...wrapAfter([sp("▣ ", "success")], bp.feature || "Unnamed feature", width, "text", true));
	if (request.planPath)
		lines.push(...pathAfter([sp("  Approving writes ", "muted")], request.planPath, width, "accent", 4));
	lines.push(...summary(bp.counts, width).map((l) => [sp("  "), ...l]), []);

	const brief = section(
		"Brief",
		bp.brief.goal ? paragraph(bp.brief.goal, width, "text", true) : [[sp("no goal", "warning")]],
		width,
	);
	const [left, right] = halves(width);
	brief.push(
		...pair(
			trim(section("Constraints", bullets(bp.brief.constraints, left), left)),
			trim(section("Out of scope", bullets(bp.brief.outOfScope, right, "×", "dim", "muted"), right)),
			width,
		),
		[],
		...section("Done when", bullets(bp.brief.doneWhen, width, "☐", "success"), width),
	);
	lines.push(...brief);

	if (bp.modules.length) lines.push(...section("Modules", moduleMap(bp.modules, width), width, legend));
	if (arch.decisions.length)
		lines.push(
			...section(
				"Decisions",
				arch.decisions.flatMap((d, i) => [...(i ? [[]] : []), ...decisionLines(d, width)]),
				width,
			),
		);
	if (bp.design.length)
		lines.push(
			...section(
				"Design",
				bp.design.flatMap((d, i) => [...(i ? [[]] : []), ...diagramLines(d, width, paint)]),
				width,
			),
		);
	lines.push(
		...section(
			"Slices",
			sliceList(
				bp.slices.map((o) => o.slice),
				width,
			),
			width,
			bp.slices.length ? [sp("build order", "dim")] : [],
		),
	);
	lines.push(...risks(arch, width));
	lines.push([sp("Approving the Blueprint makes the plan final.", "muted")]);
	return trim(lines);
};

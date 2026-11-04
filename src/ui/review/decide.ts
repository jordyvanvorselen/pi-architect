import type { Decision } from "../../state/types.ts";
import { lineWidth, sp, wrap, wrapAfter, type Line } from "../spans.ts";
import { section, trim, type ReviewBody } from "./common.ts";

/** One decision: the question, the chosen option with the comment, and the rejected options dimmed. */
export function decisionLines(decision: Decision, width: number): Line[] {
	const tag = `${decision.id} `.padEnd(4);
	const indent = " ".repeat(tag.length);
	const lines: Line[] = wrap(decision.question, Math.max(1, width - tag.length)).map((l, i) => [
		sp(i ? indent : tag, "dim"),
		sp(l, "text", true),
	]);
	const chosen = decision.options.find((o) => o.id === decision.chosen);
	if (!chosen) {
		lines.push([sp(indent), sp("○ open", "warning")]);
		return lines;
	}
	const star = chosen.id === decision.recommendation ? [sp(" ★", "warning")] : [];
	const title = wrapAfter(
		[sp(indent), sp("✓ ", "success"), sp(chosen.id, "accent", true), sp("  ")],
		chosen.title,
		width,
		"text",
		true,
	).map((l, i) => (i === 0 ? [...l, ...star] : l));
	// The agent never rated an option the user wrote. Say whose it is, beside the title when it fits.
	if (chosen.byUser) {
		const own = sp("your own option", "dim");
		const last = title.at(-1)!;
		if (lineWidth(last) + 2 + lineWidth([own]) <= width) last.push(sp("  "), own);
		else title.push([sp(`${indent}  `), own]);
	}
	lines.push(...title);
	if (chosen.byUser && chosen.summary) lines.push(...wrapAfter([sp(`${indent}  `)], chosen.summary, width, "muted"));
	if (decision.comment) lines.push(...wrapAfter([sp(`${indent}  `)], `"${decision.comment}"`, width, "muted"));
	const rejected = decision.options.filter((o) => o !== chosen);
	if (rejected.length) {
		const text = rejected.map((o) => `${o.id} ${o.title}${o.id === decision.recommendation ? " ★" : ""}`).join(" · ");
		lines.push(...wrapAfter([sp(`${indent}  `)], text, width, "dim"));
	}
	return lines;
}

/** Decide: every decision with the chosen option, the comment, and the rejected options dimmed. */
export const decideBody: ReviewBody = (arch, width) => {
	const decided = arch.decisions.filter((d) => d.chosen !== undefined).length;
	const open = arch.decisions.length - decided;
	const right = [sp(`${decided} decided`, "dim"), ...(open ? [sp(" · ", "dim"), sp(`${open} open`, "warning")] : [])];
	const body = arch.decisions.length
		? arch.decisions.flatMap((d, i) => [...(i ? [[]] : []), ...decisionLines(d, width)])
		: [[sp("No open questions. The design follows from the brief.", "muted")]];
	return trim(section("Decisions", body, width, arch.decisions.length ? right : []));
};

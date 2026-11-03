import type { Component } from "@earendil-works/pi-tui";
import type { ChoiceEvent, VerdictEvent } from "../state/events.ts";
import { nextPhase, PHASE_LABEL } from "../state/phases.ts";
import type { Decision } from "../state/types.ts";
import { meter } from "./meter.ts";
import type { Paint } from "./paint.ts";
import { clipLine, lineWidth, paintLine, sp, wrapAfter, type Line } from "./spans.ts";

/** A transcript card drawn from spans at the width it gets, so it fits and follows the theme on every render. */
export class SpanView implements Component {
	private readonly draw: (width: number) => Line[];
	private readonly paint: Paint;

	constructor(paint: Paint, draw: (width: number) => Line[]) {
		this.paint = paint;
		this.draw = draw;
	}

	render(width: number): string[] {
		const w = Math.max(1, width);
		return this.draw(w).map((line) => paintLine(clipLine(line, w), this.paint));
	}

	invalidate(): void {}
}

/** `── label ──────────`: a quiet rule across the transcript with a label in it. */
function divider(label: Line, width: number): Line {
	const head = [sp("── ", "borderMuted"), ...label, sp(" ", "borderMuted")];
	const rest = width - lineWidth(head);
	return rest > 0 ? [...head, sp("─".repeat(rest), "borderMuted")] : clipLine(head, width);
}

/**
 * A choice on a decision card. Collapsed: `◆ d1 ✓ B In backend "only alarms" · Where do …`.
 * Expanded: the question, the chosen option with its meters and the comment, and the rejected options dimmed.
 * `decision` is the decision as it is now; without it the card shows the bare choice.
 */
export function choiceEntry(
	event: ChoiceEvent,
	decision: Decision | undefined,
	expanded: boolean,
): (width: number) => Line[] {
	const option = decision?.options.find((o) => o.id === event.chosen);
	const star = option && option.id === decision?.recommendation ? [sp(" ★", "warning")] : [];
	const comment = event.comment ? [sp(`  "${event.comment}"`, "muted")] : [];
	const answer: Line = [
		sp("✓ ", "success"),
		sp(event.chosen, "accent", true),
		...(option ? [sp(` ${option.title}`, "text", true)] : []),
		...star,
	];
	return (width) => {
		if (!expanded || !decision || !option)
			return [
				[
					sp("◆ ", "accent"),
					sp(`${event.id} `, "dim"),
					...answer,
					...comment,
					...(decision ? [sp(" · ", "dim"), sp(decision.question, "muted")] : []),
				],
			];
		const lines: Line[] = wrapAfter(
			[sp("◆ ", "accent"), sp(`${event.id}  `, "dim")],
			decision.question,
			width,
			"text",
			true,
		);
		const ratings: Line = option.byUser
			? [sp("your own option", "dim")]
			: [sp("effort ", "dim"), ...meter(option.effort), sp("  risk ", "dim"), ...meter(option.risk)];
		const head: Line = [sp("  "), ...answer];
		const space = width - lineWidth(head) - lineWidth(ratings);
		lines.push(space >= 2 ? [...head, sp(" ".repeat(space)), ...ratings] : head);
		if (event.comment) lines.push(...wrapAfter([sp("    ")], `"${event.comment}"`, width, "muted"));
		for (const o of decision.options) {
			if (o === option) continue;
			const recommended = o.id === decision.recommendation ? " ★" : "";
			lines.push(...wrapAfter([sp("    "), sp(`${o.id}  `, "dim")], `${o.title}${recommended}`, width, "dim"));
		}
		return lines;
	};
}

/**
 * A verdict at a phase gate, drawn as a divider in the transcript: `── ✓ Frame approved → Explore ────`.
 * Collapsed, a comment follows on the same line; expanded, it wraps below.
 */
export function verdictEntry(event: VerdictEvent, expanded: boolean): (width: number) => Line[] {
	const label = PHASE_LABEL[event.phase];
	const next = nextPhase(event.phase);
	const title: Line =
		event.verdict === "approved"
			? [
					sp(`✓ ${label} approved`, "success", true),
					sp(next ? ` → ${PHASE_LABEL[next]}` : " · the plan is final", "dim"),
				]
			: [sp(`↻ ${label}: changes requested`, "warning", true)];
	return (width) => {
		if (!event.comment) return [divider(title, width)];
		if (!expanded) return [divider([...title, sp(`  "${event.comment}"`, "muted")], width)];
		return [divider(title, width), ...wrapAfter([sp("   ")], `"${event.comment}"`, width, "muted")];
	};
}

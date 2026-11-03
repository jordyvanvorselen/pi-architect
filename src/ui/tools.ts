import { PHASE_LABEL } from "../state/phases.ts";
import type { AdvanceDetails, AdvanceInput } from "../tools/advance.ts";
import type { UpdateDetails, UpdateInput } from "../tools/update.ts";
import type { Paint } from "./paint.ts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function title(paint: Paint, action: string): string {
	return `${paint.fg("accent", "◆")} ${paint.fg("toolTitle", paint.bold(`architect ${action}`))}`;
}

/** `◆ architect update  brief · 2 modules · 1 risk`. Arguments may still be streaming in. */
export function updateCall(args: Partial<UpdateInput> | undefined, paint: Paint): string {
	const a = args ?? {};
	const parts: string[] = [];
	if (a.feature) parts.push(`"${a.feature}"`);
	if (a.brief) parts.push("brief");
	if (Array.isArray(a.modules) && a.modules.length) parts.push(plural(a.modules.length, "module"));
	if (Array.isArray(a.findings) && a.findings.length) parts.push(plural(a.findings.length, "finding"));
	if (Array.isArray(a.risks) && a.risks.length) parts.push(plural(a.risks.length, "risk"));
	if (Array.isArray(a.remove) && a.remove.length) parts.push(`remove ${a.remove.length}`);
	const what = parts.length ? `  ${paint.fg("muted", parts.join(" · "))}` : "";
	return title(paint, "update") + what;
}

/** One line when collapsed; every change and what the phase still needs when expanded. */
export function updateResult(
	details: UpdateDetails | undefined,
	text: string,
	expanded: boolean,
	isError: boolean,
	paint: Paint,
): string {
	if (isError || !details) return paint.fg(isError ? "error" : "muted", `${isError ? "✗ " : ""}${text}`);
	const label = PHASE_LABEL[details.phase];
	const state = details.missing.length
		? paint.fg("warning", `${label} needs ${details.missing.join(", ")}`)
		: paint.fg("success", `${label} ready for review`);
	if (!expanded)
		return `${paint.fg("success", "✓")} ${paint.fg("muted", details.changes.join(" · "))} ${paint.fg("dim", "·")} ${state}`;
	return [
		...details.changes.map((change) => `${paint.fg("success", "✓")} ${paint.fg("muted", change)}`),
		`${details.missing.length ? paint.fg("warning", "○") : paint.fg("success", "●")} ${state}`,
	].join("\n");
}

/** `◆ architect advance  what to check`. */
export function advanceCall(args: Partial<AdvanceInput> | undefined, paint: Paint): string {
	const summary = args?.summary?.trim();
	return title(paint, "advance") + (summary ? `  ${paint.fg("dim", summary)}` : "");
}

/** The gate's outcome: approved, changes requested, closed, not ready, or no UI. */
export function advanceResult(
	details: AdvanceDetails | undefined,
	text: string,
	isPartial: boolean,
	paint: Paint,
): string {
	if (isPartial) return paint.fg("warning", "◉ waiting for your review…");
	if (!details) return paint.fg("error", `✗ ${text}`);
	const label = PHASE_LABEL[details.phase];
	const comment = details.comment ? paint.fg("muted", `  "${details.comment}"`) : "";
	switch (details.outcome) {
		case "approved":
			if (details.final)
				return (
					paint.fg("success", `✓ ${label} approved · the plan is final`) +
					(details.planPath ? paint.fg("dim", ` · ${details.planPath}`) : "") +
					comment
				);
			return paint.fg("success", `✓ ${label} approved`) + paint.fg("dim", ` → ${PHASE_LABEL[details.next!]}`) + comment;
		case "changes":
			return paint.fg("warning", `↻ changes requested for ${label}`) + comment;
		case "closed":
			return paint.fg("dim", `■ ${label} review closed without a decision`);
		case "not-ready":
			return paint.fg("warning", `○ ${label} not ready: needs ${(details.missing ?? []).join(", ")}`);
		case "no-ui":
			return paint.fg("dim", `■ no interactive UI to review ${label}`);
	}
}

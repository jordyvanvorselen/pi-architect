// How an `architect_diagram` call looks in the transcript: a one-line summary, the full card when expanded, and
// the linter's findings when the drawing was rejected.
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type DiagramFinding, type DiagramTheme } from "../diagram/index.ts";
import { wrap } from "../diagram/text.ts";
import { PHASE_LABEL } from "../state/phases.ts";
import type { DiagramDetails, DiagramInput } from "../tools/diagram.ts";
import { captionedDiagram } from "./captioned.ts";
import type { Paint } from "./paint.ts";

type Theme = Paint & DiagramTheme;

/** The parts of Pi's render context used here. */
export interface RenderContext {
	lastComponent?: unknown;
	isError?: boolean;
	keyHint?(keybinding: "app.tools.expand", description: string): string;
}

/** A component that draws its lines for the width it gets. */
export class LinesView implements Component {
	private draw: (width: number) => string[] = () => [];

	set(draw: (width: number) => string[]): this {
		this.draw = draw;
		return this;
	}

	render(width: number): string[] {
		return this.draw(Math.max(1, width));
	}

	invalidate(): void {}
}

const view = (context: RenderContext) =>
	context.lastComponent instanceof LinesView ? context.lastComponent : new LinesView();

const fit = (line: string, width: number) => (visibleWidth(line) <= width ? line : truncateToWidth(line, width, "…"));

function head(paint: Paint, extra: string): string {
	return `${paint.fg("accent", "◆")} ${paint.fg("toolTitle", paint.bold("architect diagram"))}${extra}`;
}

/** `◆ architect diagram  "Event flow" · replaces d2`. The arguments may still be streaming in. */
export function diagramCall(
	args: Partial<DiagramInput> | undefined,
	theme: unknown,
	context: RenderContext,
): Component {
	const paint = theme as Paint;
	const parts: string[] = [];
	const title = typeof args?.title === "string" ? args.title.trim() : "";
	if (title) parts.push(`"${title}"`);
	if (typeof args?.id === "string" && args.id.trim()) parts.push(`replaces ${args.id.trim()}`);
	const what = parts.length ? `  ${paint.fg("muted", parts.join(" · "))}` : "";
	const line = head(paint, what);
	return view(context).set((width) => [fit(line, width)]);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function findingLine(f: DiagramFinding, paint: Paint): string {
	const where = f.line ? `${f.line}:${f.col} ` : "";
	const mark = f.severity === "error" ? paint.fg("error", "✗") : paint.fg("warning", "!");
	return `${mark} ${paint.fg("dim", where)}${paint.fg("muted", f.message)}`;
}

/** Findings, one per line when collapsed, wrapped in full when expanded. */
function findingLines(findings: readonly DiagramFinding[], expanded: boolean, width: number, paint: Paint): string[] {
	if (!expanded) return findings.map((f) => fit(`  ${findingLine(f, paint)}`, width));
	return findings.flatMap((f) => {
		const where = f.line ? `${f.line}:${f.col} ` : "";
		const mark = f.severity === "error" ? paint.fg("error", "✗") : paint.fg("warning", "!");
		return wrap(`${where}${f.message}`, Math.max(10, width - 4), 8).map(
			(line, i) => `  ${i ? " " : mark} ${paint.fg("muted", line)}`,
		);
	});
}

/**
 * Saved: `✓ d1 "Event flow" · 9 × 64 · Design ready` and, expanded, the diagram card. Rejected: the counts and the
 * first findings, all of them when expanded.
 */
export function diagramResult(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	options: { expanded: boolean; isPartial?: boolean },
	theme: unknown,
	context: RenderContext,
): Component {
	const paint = theme as Theme;
	const details = result.details as DiagramDetails | undefined;
	const text = result.content.map((c) => c.text ?? "").join("\n");
	const hint = context.keyHint?.("app.tools.expand", "to expand") ?? "ctrl+o to expand";
	const v = view(context);
	if (options.isPartial) return v.set((width) => [fit(paint.fg("muted", "checking the diagram…"), width)]);
	if (!details)
		return v.set((width) => wrap(text, width, 6).map((l) => paint.fg(context.isError ? "error" : "muted", l)));

	if (details.outcome === "rejected") {
		const counts = [plural(details.errors, "error"), details.warnings ? plural(details.warnings, "warning") : ""]
			.filter(Boolean)
			.join(", ");
		const summary = `${paint.fg("error", "✗ diagram rejected")} ${paint.fg("muted", `· ${counts} · the agent redraws it`)}`;
		const shown = options.expanded ? details.findings : details.findings.slice(0, 3);
		const more = details.findings.length - shown.length;
		return v.set((width) => [
			fit(summary, width),
			...findingLines(shown, options.expanded, width, paint),
			...(more > 0 ? [fit(paint.fg("dim", `  …${more} more (${hint})`), width)] : []),
		]);
	}

	const { diagram } = details;
	const label = PHASE_LABEL[details.phase];
	const state = details.missing.length
		? paint.fg("warning", `${label} needs ${details.missing.join(", ")}`)
		: paint.fg("success", `${label} ready for review`);
	const warn = details.warnings.length
		? ` ${paint.fg("warning", `· ${plural(details.warnings.length, "warning")}`)}`
		: "";
	const summary =
		`${paint.fg("success", "✓")} ${paint.fg("muted", `${details.replaced ? "replaced" : "saved"} ${diagram.id}`)} ` +
		`${paint.bold(`"${diagram.title}"`)} ${paint.fg("dim", `· ${details.lines} × ${details.cols}`)}${warn} ${paint.fg("dim", "·")} ${state}`;
	if (!options.expanded) return v.set((width) => [fit(`${summary} ${paint.fg("dim", `(${hint})`)}`, width)]);
	return v.set((width) => [
		fit(summary, width),
		...captionedDiagram(diagram, width, paint),
		...findingLines(details.warnings, true, width, paint),
	]);
}

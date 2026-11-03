import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { PHASE_LABEL, PHASE_SHORT, PHASES, phaseIndex, type Phase } from "../state/phases.ts";
import { counts, phaseState } from "../state/queries.ts";
import type { Architecture, PhaseState } from "../state/types.ts";
import { clip, firstFit, join, paintSeg, seg, spread, width, type Paint, type Seg } from "./paint.ts";

/** Longest feature name the stepper shows before it cuts it. */
const FEATURE_MAX = 32;

type NameStyle = "full" | "short" | "glyph";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function step(phase: Phase, state: PhaseState, style: NameStyle, paint: Paint): Seg {
	const current = state === "working" || state === "review";
	const name = current || style === "full" ? PHASE_LABEL[phase] : PHASE_SHORT[phase];
	switch (state) {
		case "approved":
			return style === "glyph"
				? paintSeg(paint, "success", "✓")
				: join([paintSeg(paint, "success", "✓"), paintSeg(paint, "muted", name)], seg(" "));
		case "working":
			return join([paintSeg(paint, "accent", "●"), paintSeg(paint, "accent", name, true)], seg(" "));
		case "review":
			return join([paintSeg(paint, "warning", "◉"), paintSeg(paint, "warning", name, true)], seg(" "));
		case "pending":
			return style === "glyph" ? paintSeg(paint, "dim", "○") : paintSeg(paint, "dim", name);
	}
}

/** `✓ Frame ━━ ● Explore ┄┄ Decide ┄┄ …`: solid links behind approved phases, dashed ahead. */
function steps(arch: Architecture, style: NameStyle, paint: Paint): Seg {
	const parts: Seg[] = [];
	const link = style === "glyph" ? 1 : 2;
	PHASES.forEach((phase, i) => {
		const state = phaseState(arch, phase);
		if (i > 0) {
			const done = phaseState(arch, PHASES[i - 1]!) === "approved";
			parts.push(seg(" "), paintSeg(paint, done ? "success" : "dim", (done ? "━" : "┄").repeat(link)), seg(" "));
		}
		parts.push(step(phase, state, style, paint));
	});
	return join(parts);
}

/** Right side: review state, decisions and risks. Empty when there is nothing to report. */
function counters(arch: Architecture, paint: Paint): Seg {
	const items: Seg[] = [];
	if (arch.approvedAt !== undefined) items.push(paintSeg(paint, "success", "plan approved"));
	else if (arch.status === "review") items.push(paintSeg(paint, "warning", "awaiting your review"));
	const c = counts(arch);
	if (c.open) items.push(paintSeg(paint, "accent", `${c.open} open`));
	if (c.decided) items.push(paintSeg(paint, "muted", `${c.decided} decided`));
	if (c.risks) items.push(paintSeg(paint, c.highRisks ? "error" : "warning", `⚠ ${plural(c.risks, "risk")}`));
	return join(items, paintSeg(paint, "dim", " · "));
}

/**
 * The phases alone, as wide as fits: `✓ Frame ━━ ● Explore ┄┄ Decide …`, then short names, then glyphs,
 * then only the current phase. The board shows this under its title.
 */
export function renderSteps(arch: Architecture, total: number, paint: Paint): string {
	const color = arch.approvedAt === undefined && arch.status === "review" ? "warning" : "accent";
	return firstFit(
		[
			steps(arch, "full", paint),
			steps(arch, "short", paint),
			steps(arch, "glyph", paint),
			join([
				paintSeg(paint, color, PHASE_LABEL[arch.phase], true),
				paintSeg(paint, "dim", ` ${phaseIndex(arch.phase) + 1}/${PHASES.length}`),
			]),
		],
		total,
	);
}

/**
 * The stepper line above the editor in architect mode:
 * ` ◆ ARCHITECT  dedupe-panel-events  ✓ Frame ━━ ● Explore ┄┄ Decide …      3 open · ⚠ 1 risk`.
 * At narrow widths it drops the feature, then the counters, then shortens the phase names, so the
 * line always fits. `hint`, e.g. `ctrl+alt+b board`, goes after the counters while there is room for it.
 */
export function renderStepper(arch: Architecture, total: number, paint: Paint, hint?: string): string {
	const brand = paintSeg(paint, "accent", "◆ ARCHITECT", true);
	const mark = paintSeg(paint, "accent", "◆", true);
	const feature = arch.feature ? paintSeg(paint, "text", clip(arch.feature, FEATURE_MAX)) : undefined;
	const right = counters(arch, paint);
	const pad = seg(" ");
	const gap = seg("  ");
	const line = (...parts: Seg[]) => join([pad, ...parts]);

	const full = steps(arch, "full", paint);
	const short = steps(arch, "short", paint);
	const glyph = steps(arch, "glyph", paint);
	const wide: Seg[] = [...(feature ? [line(brand, gap, feature, gap, full)] : []), line(brand, gap, full)];
	if (hint) {
		const key = paintSeg(paint, "dim", hint);
		const withHint = width(right) > 0 ? join([right, paintSeg(paint, "dim", "   "), key]) : key;
		for (const left of wide) {
			const fitted = spread(left, withHint, total, 3);
			if (fitted !== undefined) return fitted;
		}
	}
	if (width(right) > 0) {
		for (const left of wide) {
			const fitted = spread(left, right, total);
			if (fitted !== undefined) return fitted;
		}
	}
	const current = PHASE_LABEL[arch.phase];
	const position = paintSeg(paint, "dim", `${phaseIndex(arch.phase) + 1}/${PHASES.length}`);
	const candidates = [
		...(feature && width(right) === 0 ? [line(brand, gap, feature, gap, full)] : []),
		line(brand, gap, full),
		line(brand, gap, short),
		line(brand, gap, glyph),
		line(mark, pad, glyph),
		line(mark, pad, paintSeg(paint, "accent", current, true), pad, position),
	];
	return firstFit(candidates, total);
}

/** Widget component that draws a line from the current state on every render. Cheap, so no cache. */
export class LineComponent implements Component {
	private readonly draw: (width: number) => string | undefined;

	constructor(draw: (width: number) => string | undefined) {
		this.draw = draw;
	}

	render(total: number): string[] {
		const line = this.draw(total);
		return line === undefined ? [] : [truncateToWidth(line, total)];
	}

	invalidate(): void {}
}

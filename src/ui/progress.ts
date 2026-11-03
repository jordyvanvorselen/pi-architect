import { isDone, sliceStates, type SliceProgress, type SliceState } from "../plan/progress.ts";
import { clip, firstFit, join, paintSeg, seg, spread, width, type Paint, type Seg } from "./paint.ts";

/** Longest plan name the widget shows before it cuts it. */
const NAME_MAX = 32;
/** A title cut shorter than this says nothing, so the widget drops it instead. */
const TITLE_MIN = 8;

/** What the build widget shows. */
export interface BuildView {
	/** The plan's slug. */
	name: string;
	slices: readonly SliceProgress[];
	/** Shown instead of the current slice, e.g. that the plan file is missing. */
	problem?: string;
}

const GLYPH: Record<SliceState, string> = { done: "✓", active: "●", pending: "○" };
const COLOR = { done: "success", active: "accent", pending: "dim" } as const;

function glyphs(slices: readonly SliceProgress[], states: SliceState[], numbered: boolean, paint: Paint): Seg {
	const parts = slices.map((s, i) => {
		const state = states[i]!;
		return paintSeg(paint, COLOR[state], numbered ? `${GLYPH[state]}${s.number}` : GLYPH[state], state === "active");
	});
	return join(parts, seg(numbered ? " " : ""));
}

/**
 * The build widget above the editor, for a session with an approved plan:
 * ` ▸ BUILD  plan: dedupe-panel-events  ✓1 ✓2 ●3 ○4   slice 3/4 · Store dedup key`.
 * At narrow widths it cuts the title, then drops the plan name, the title and the numbers, so the line
 * always fits. `hint`, e.g. `ctrl+alt+b board`, goes at the right edge while the whole line fits with it.
 */
export function renderBuildProgress(view: BuildView, total: number, paint: Paint, hint?: string): string {
	const pad = seg(" ");
	const gap = seg("  ");
	const wide = seg("   ");
	const brand = paintSeg(paint, "muted", "▸ BUILD", true);
	const mark = paintSeg(paint, "muted", "▸", true);
	const name = join([paintSeg(paint, "dim", "plan: "), paintSeg(paint, "text", clip(view.name, NAME_MAX))]);
	const line = (...parts: Seg[]) => join([pad, ...parts]);

	const { slices } = view;
	const states = sliceStates(slices);
	const full = glyphs(slices, states, true, paint);
	const compact = glyphs(slices, states, false, paint);
	const current = states.findIndex((s) => s !== "done");
	const done = slices.length > 0 && slices.every(isDone);

	let label: Seg;
	let short: Seg;
	let title = "";
	let position: Seg;
	if (view.problem) {
		label = short = paintSeg(paint, "warning", view.problem);
		position = paintSeg(paint, "warning", "⚠");
	} else if (done) {
		label = short = paintSeg(paint, "success", `all ${slices.length} slice${slices.length === 1 ? "" : "s"} done`);
		position = paintSeg(paint, "success", "done");
	} else if (current >= 0) {
		const at = `${current + 1}/${slices.length}`;
		short = paintSeg(paint, "muted", `slice ${at}`);
		label = join([short, paintSeg(paint, "dim", " · ")]);
		title = slices[current]!.title;
		position = paintSeg(paint, "muted", at);
	} else {
		label = short = paintSeg(paint, "dim", "no slices");
		position = paintSeg(paint, "dim", "0/0");
	}

	/** The label with as much of the title as fits after `prefix`, or undefined when too little fits. */
	const status = (prefix: Seg, cut: boolean): Seg | undefined => {
		if (!title) return join([prefix, label]);
		if (!cut) return join([prefix, label, paintSeg(paint, "text", title)]);
		const room = total - width(prefix) - width(label);
		if (room < TITLE_MIN) return undefined;
		return join([prefix, label, paintSeg(paint, "text", clip(title, room))]);
	};
	const withRun = (head: Seg[], run: Seg) => (width(run) ? line(...head, gap, run, wide) : line(...head, gap));

	const first = status(withRun([brand, gap, name], full), false);
	const hinted = first && hint ? spread(first, paintSeg(paint, "dim", hint), total, 3) : undefined;
	if (hinted !== undefined) return hinted;
	const candidates = [
		first,
		status(withRun([brand, gap, name], full), true),
		status(withRun([brand], full), false),
		status(withRun([brand], full), true),
		join([withRun([brand], full), short]),
		...(view.problem ? [line(brand, gap, short)] : [join([withRun([brand], full), position])]),
		line(brand, gap, compact, gap, position),
		line(mark, pad, compact, pad, position),
		line(mark, pad, position),
	].filter((c): c is Seg => c !== undefined);
	return firstFit(candidates, total);
}

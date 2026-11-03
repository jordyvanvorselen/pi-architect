import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SliceProgress } from "../src/plan/progress.ts";
import { renderBuildProgress, type BuildView } from "../src/ui/progress.ts";
import { assertFits, plainTheme, tagTheme } from "./helpers.ts";

const s = (number: number, title: string, checked: number, total = 3): SliceProgress => ({
	number,
	title,
	total,
	checked,
});

const VIEW: BuildView = {
	name: "dedupe-panel-events",
	slices: [
		s(1, "Add the dedup key column", 3),
		s(2, "Show skipped duplicates", 3),
		s(3, "Store dedup key", 1),
		s(4, "Skip duplicates on insert", 0),
	],
};

const at = (width: number, view: BuildView = VIEW) => renderBuildProgress(view, width, plainTheme);

describe("build progress widget", () => {
	it("shows the plan, every slice and the current one at widths 30, 40, 80 and 120", () => {
		const lines = assertFits((width, theme) => [renderBuildProgress(VIEW, width, theme)]);
		assert.deepEqual(Object.fromEntries(lines), {
			30: [" ▸ BUILD  ✓1 ✓2 ●3 ○4   3/4"],
			40: [" ▸ BUILD  ✓1 ✓2 ●3 ○4   slice 3/4"],
			80: [" ▸ BUILD  plan: dedupe-panel-events  ✓1 ✓2 ●3 ○4   slice 3/4 · Store dedup key"],
			120: [" ▸ BUILD  plan: dedupe-panel-events  ✓1 ✓2 ●3 ○4   slice 3/4 · Store dedup key"],
		});
	});

	it("cuts the title before it drops it", () => {
		assert.equal(at(50), " ▸ BUILD  ✓1 ✓2 ●3 ○4   slice 3/4 · Store dedup k…");
		assert.equal(at(60), " ▸ BUILD  ✓1 ✓2 ●3 ○4   slice 3/4 · Store dedup key");
	});

	it("colours done slices green, the current one in accent and pending ones dim", () => {
		assert.equal(
			renderBuildProgress(VIEW, 120, tagTheme),
			" <muted><b>▸ BUILD</b></muted>  <dim>plan: </dim><text>dedupe-panel-events</text>  " +
				"<success>✓1</success> <success>✓2</success> <accent><b>●3</b></accent> <dim>○4</dim>   " +
				"<muted>slice 3/4</muted><dim> · </dim><text>Store dedup key</text>",
		);
	});

	it("marks a started slice after the current one as active too", () => {
		const view = { ...VIEW, slices: [s(1, "a", 0), s(2, "b", 1), s(3, "c", 0)] };
		assert.equal(at(80, view), " ▸ BUILD  plan: dedupe-panel-events  ●1 ●2 ○3   slice 1/3 · a");
	});

	it("drops the numbers with many slices", () => {
		const view = { name: "x", slices: Array.from({ length: 14 }, (_, i) => s(i + 1, `Title ${i + 1}`, i < 5 ? 3 : 0)) };
		const lines = assertFits((width, theme) => [renderBuildProgress(view, width, theme)]);
		assert.equal(lines.get(30)![0], " ▸ BUILD  ✓✓✓✓✓●○○○○○○○○  6/14");
		assert.equal(lines.get(80)![0], " ▸ BUILD  ✓1 ✓2 ✓3 ✓4 ✓5 ●6 ○7 ○8 ○9 ○10 ○11 ○12 ○13 ○14   slice 6/14 · Title 6");
		assert.equal(at(22, view), " ▸ ✓✓✓✓✓●○○○○○○○○ 6/14");
		assert.equal(at(12, view), " ▸ 6/14");
		assert.deepEqual(assertFits((width, theme) => [renderBuildProgress(view, width, theme)], [5]).get(5), [" ▸ 6…"]);
	});

	it("says when every slice is done", () => {
		const view = { ...VIEW, slices: VIEW.slices.map((x) => ({ ...x, checked: x.total })) };
		assertFits((width, theme) => [renderBuildProgress(view, width, theme)]);
		assert.equal(at(80, view), " ▸ BUILD  plan: dedupe-panel-events  ✓1 ✓2 ✓3 ✓4   all 4 slices done");
		assert.equal(at(30, view), " ▸ BUILD  ✓1 ✓2 ✓3 ✓4   done");
		assert.equal(
			at(80, { ...view, slices: [s(1, "a", 3)] }),
			" ▸ BUILD  plan: dedupe-panel-events  ✓1   all 1 slice done",
		);
	});

	it("shows a problem instead of the current slice", () => {
		const view = { ...VIEW, problem: "plan file not found · /plan" };
		const lines = assertFits((width, theme) => [renderBuildProgress(view, width, theme)]);
		assert.deepEqual(Object.fromEntries(lines), {
			30: [" ▸ BUILD  ✓✓●○  ⚠"],
			40: [" ▸ BUILD  plan file not found · /plan"],
			80: [" ▸ BUILD  plan: dedupe-panel-events  ✓1 ✓2 ●3 ○4   plan file not found · /plan"],
			120: [" ▸ BUILD  plan: dedupe-panel-events  ✓1 ✓2 ●3 ○4   plan file not found · /plan"],
		});
		assert.equal(
			at(80, { name: "x", slices: [], problem: "plan not written · /plan write" }),
			" ▸ BUILD  plan: x  plan not written · /plan write",
		);
	});

	it("handles a plan without slices and cuts a long name", () => {
		assert.equal(at(80, { name: "x", slices: [] }), " ▸ BUILD  plan: x  no slices");
		assert.equal(
			at(120, { ...VIEW, name: "a-very-long-plan-name-that-goes-on-and-on-forever" }),
			" ▸ BUILD  plan: a-very-long-plan-name-that-goes…  ✓1 ✓2 ●3 ○4   slice 3/4 · Store dedup key",
		);
	});
});

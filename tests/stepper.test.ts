import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { newArchitecture } from "../src/state/reducer.ts";
import type { Architecture } from "../src/state/types.ts";
import { clip, firstFit, join, paintSeg, seg, spread } from "../src/ui/paint.ts";
import { LineComponent, renderPlanProgress, renderStepper } from "../src/ui/stepper.ts";
import { modeStatus } from "../src/ui/status.ts";
import { assertComponentFits, assertFits, plainTheme, tagTheme, untag } from "./helpers.ts";

const option = { id: "A", title: "a", pros: [], cons: [], effort: 1 as const, risk: 1 as const };

function arch(partial: Partial<Architecture> = {}): Architecture {
	return {
		...newArchitecture(1, "dedupe-panel-events", "dedupe-panel-events"),
		phase: "decide",
		decisions: [
			{ id: "d1", question: "q", options: [option] },
			{ id: "d2", question: "q", options: [option] },
			{ id: "d3", question: "q", options: [option] },
			{ id: "d4", question: "q", options: [option], chosen: "A" },
			{ id: "d5", question: "q", options: [option], chosen: "A" },
		],
		risks: [{ id: "r1", text: "x", severity: "medium" }],
		...partial,
	};
}

const at = (width: number, a = arch()) => renderStepper(a, width, plainTheme);

describe("stepper", () => {
	it("shows the brand, the feature, every phase and the counters when wide", () => {
		assert.match(
			at(140),
			/^ ◆ ARCHITECT {2}dedupe-panel-events {2}✓ Frame ━━ ✓ Explore ━━ ● Decide ┄┄ Design ┄┄ Slice ┄┄ Blueprint {12}3 open · 2 decided · ⚠ 1 risk$/,
		);
		assert.equal(at(140).length, 140);
	});

	it("colours approved phases green, the current one in accent and pending ones dim", () => {
		const line = renderStepper(arch(), 140, tagTheme);
		assert.match(line, /<success>✓<\/success> <muted>Frame<\/muted> <success>━━<\/success>/);
		assert.match(line, /<accent>●<\/accent> <accent><b>Decide<\/b><\/accent> <dim>┄┄<\/dim> <dim>Design<\/dim>/);
		assert.match(line, /<warning>⚠ 1 risk<\/warning>/);
		assert.match(line, /<accent><b>◆ ARCHITECT<\/b><\/accent>/);
	});

	it("shows a phase in review in warning colour with a note", () => {
		const line = renderStepper(arch({ status: "review" }), 140, tagTheme);
		assert.match(line, /<warning>◉<\/warning> <warning><b>Decide<\/b><\/warning>/);
		assert.match(untag(line), /awaiting your review · 3 open/);
	});

	it("marks high risks in error colour and counts them in the plural", () => {
		const line = renderStepper(
			arch({
				risks: [
					{ id: "r1", text: "x", severity: "high" },
					{ id: "r2", text: "y", severity: "low" },
				],
			}),
			140,
			tagTheme,
		);
		assert.match(line, /<error>⚠ 2 risks<\/error>/);
	});

	it("shows every phase approved once the plan is approved", () => {
		const line = at(140, arch({ phase: "blueprint", approvedAt: 9, decisions: [], risks: [] }));
		assert.match(line, /✓ Slice ━━ ✓ Blueprint\s+plan approved$/);
	});

	it("leaves the feature out while it has no name, and the counters while there are none", () => {
		assert.equal(
			at(120, arch({ feature: "", phase: "frame", decisions: [], risks: [] })),
			" ◆ ARCHITECT  ● Frame ┄┄ Explore ┄┄ Decide ┄┄ Design ┄┄ Slice ┄┄ Blueprint",
		);
	});

	it("cuts a long feature name", () => {
		const line = at(200, arch({ feature: "a very long feature name that goes on and on and on" }));
		assert.match(line, /a very long feature name that g…/);
	});

	it("drops the feature, then the counters, then shortens the names, as the width shrinks", () => {
		assert.match(
			at(130),
			/^ ◆ ARCHITECT {2}dedupe-panel-events {2}✓ Frame .* Blueprint {2}3 open · 2 decided · ⚠ 1 risk$/,
		);
		assert.match(
			at(110),
			/^ ◆ ARCHITECT {2}✓ Frame ━━ ✓ Explore ━━ ● Decide ┄┄ Design ┄┄ Slice ┄┄ Blueprint\s+3 open · 2 decided · ⚠ 1 risk$/,
		);
		assert.equal(at(100), " ◆ ARCHITECT  ✓ Frame ━━ ✓ Explore ━━ ● Decide ┄┄ Design ┄┄ Slice ┄┄ Blueprint");
		assert.equal(at(70), " ◆ ARCHITECT  ✓ Frm ━━ ✓ Exp ━━ ● Decide ┄┄ Dsn ┄┄ Slc ┄┄ Bpt");
		assert.equal(at(50), " ◆ ARCHITECT  ✓ ━ ✓ ━ ● Decide ┄ ○ ┄ ○ ┄ ○");
		assert.equal(at(40), " ◆ ✓ ━ ✓ ━ ● Decide ┄ ○ ┄ ○ ┄ ○");
		assert.equal(at(30), " ◆ Decide 3/6");
		assert.equal(stripTerminalSequences(at(10)), " ◆ Decide…");
	});

	it("fits every width in every phase and status", () => {
		for (const phase of ["frame", "explore", "decide", "design", "slice", "blueprint"] as const)
			for (const status of ["working", "review"] as const)
				assertFits(
					(width, theme) => [renderStepper(arch({ phase, status }), width, theme)],
					[10, 20, 30, 40, 60, 80, 100, 120],
				);
	});
});

describe("plan progress placeholder", () => {
	it("shows the feature and the number of slices", () => {
		const slices = [{ id: "s1", title: "t", dependsOn: [], files: [], steps: [], verify: [] }];
		assert.equal(renderPlanProgress(arch({ slices }), 80, plainTheme), " ▸ BUILD  dedupe-panel-events · 1 slice");
		assert.equal(renderPlanProgress(arch({ feature: "" }), 80, plainTheme), " ▸ BUILD  0 slices");
		assertFits((width, theme) => [renderPlanProgress(arch(), width, theme)]);
	});
});

describe("mode status", () => {
	it("shows architect mode with the phase in accent and build mode muted", () => {
		assert.equal(
			modeStatus({ mode: "architect", architecture: arch() }, tagTheme),
			"<accent>◆ architect · Decide</accent>",
		);
		assert.equal(
			modeStatus({ mode: "architect", architecture: arch({ status: "review" }) }, plainTheme),
			"◆ architect · Decide · review",
		);
		assert.equal(
			modeStatus({ mode: "architect", architecture: arch({ approvedAt: 3 }) }, plainTheme),
			"◆ architect · plan approved",
		);
		assert.equal(modeStatus({ mode: "architect" }, plainTheme), "◆ architect");
		assert.equal(modeStatus({ mode: "build" }, tagTheme), "<muted>▸ build</muted>");
		assert.equal(
			modeStatus({ mode: "build", architecture: arch({ approvedAt: 3 }) }, plainTheme),
			"▸ build · plan approved",
		);
	});
});

describe("line helpers", () => {
	it("spread pushes the right part to the edge and gives up without a gap", () => {
		assert.equal(spread(seg("ab"), seg("cd"), 8), "ab    cd");
		assert.equal(spread(seg("ab"), seg("cd"), 5), undefined);
	});

	it("firstFit picks the first candidate that fits, else cuts the last", () => {
		assert.equal(firstFit([seg("long one"), seg("short")], 6), "short");
		assert.equal(stripTerminalSequences(firstFit([seg("long one"), seg("shorter")], 4)), "sho…");
		assert.equal(firstFit([], 4), "");
	});

	it("clip cuts plain text with an ellipsis", () => {
		assert.equal(clip("abcdef", 4), "abc…");
		assert.equal(clip("abc", 4), "abc");
	});

	it("join keeps plain and styled text in step", () => {
		const joined = join([paintSeg(tagTheme, "accent", "a", true), seg("b")], seg("-"));
		assert.deepEqual(joined, { plain: "a-b", styled: "<accent><b>a</b></accent>-b" });
	});

	it("LineComponent renders one fitted line, or nothing", () => {
		assertComponentFits(new LineComponent((w) => "x".repeat(w + 5)));
		assert.deepEqual(new LineComponent(() => undefined).render(40), []);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewLines, selectReview } from "../src/review.ts";
import { newArchitecture } from "../src/state/reducer.ts";
import type { Architecture } from "../src/state/types.ts";
import { advanceResult, updateCall, updateResult } from "../src/ui/tools.ts";
import { assertFits, FakeUi, plainTheme, tagTheme } from "./helpers.ts";

const option = (id: string, title: string) => ({ id, title, pros: [], cons: [], effort: 2 as const, risk: 1 as const });

const arch: Architecture = {
	...newArchitecture(1, "Dedupe", "dedupe"),
	brief: {
		goal: "Fewer duplicate alarms",
		constraints: ["no new infra", "keep the API"],
		outOfScope: [],
		doneWhen: ["no duplicates"],
	},
	modules: [
		{ path: "src/ingest", role: "touched", files: [], note: "dedupe here" },
		{ path: "src/api", role: "context", files: [] },
	],
	findings: [{ id: "f1", text: "events arrive twice" }],
	risks: [{ id: "r1", text: "ordering across nodes", severity: "high" }],
	decisions: [
		{
			id: "d1",
			question: "Where?",
			options: [option("A", "In processor"), option("B", "In backend")],
			chosen: "B",
			comment: "only alarms",
		},
		{ id: "d2", question: "How long?", options: [option("A", "1 min")] },
	],
	diagrams: [{ id: "g1", phase: "design", title: "Event flow", body: "a ──▶ b" }],
	slices: [
		{ id: "s1", title: "Dedupe table", dependsOn: [], files: [], steps: [], verify: ["npm test"] },
		{ id: "s2", title: "Wire it", dependsOn: ["s1"], files: [], steps: [], verify: ["npm test"] },
	],
};

describe("review lines", () => {
	it("show the content of each phase, and the risks", () => {
		assert.deepEqual(reviewLines(arch, "frame"), [
			"Feature: Dedupe",
			"Goal: Fewer duplicate alarms",
			"Constraints: no new infra; keep the API",
			"Out of scope: –",
			"Done when: no duplicates",
			"⚠ high ordering across nodes",
		]);
		assert.deepEqual(reviewLines(arch, "explore").slice(0, 3), [
			"touched src/ingest – dedupe here",
			"context src/api",
			"• events arrive twice",
		]);
		assert.deepEqual(reviewLines(arch, "decide").slice(0, 2), [
			"Where? → B In backend (only alarms)",
			"How long? → open",
		]);
		assert.equal(reviewLines(arch, "design")[0], "▣ Event flow");
		assert.deepEqual(reviewLines(arch, "slice").slice(0, 2), ["s1 Dedupe table", "s2 Wire it (after s1)"]);
		assert.deepEqual(reviewLines(arch, "blueprint").slice(0, 2), [
			"Dedupe: Fewer duplicate alarms",
			"2 modules · 1 decisions · 1 diagrams · 2 slices",
		]);
	});

	it("say so when a phase is empty", () => {
		const empty = newArchitecture(1);
		assert.deepEqual(reviewLines(empty, "decide"), ["No open questions."]);
		assert.deepEqual(reviewLines(empty, "design"), ["No diagrams."]);
		assert.equal(reviewLines(empty, "frame")[0], "Feature: –");
	});
});

describe("the simple review dialog", () => {
	const ctx = (ui: FakeUi) => ({ ui }) as never;

	it("approves", async () => {
		const ui = new FakeUi({ select: ["Approve Frame"] });
		assert.deepEqual(await selectReview({ arch, phase: "frame" }, ctx(ui)), { verdict: "approved" });
		assert.deepEqual(ui.prompts[0]!.detail, ["Approve Frame", "Request changes"]);
		assert.match(ui.prompts[0]!.title, /^Review Frame\n\nFeature: Dedupe/);
	});

	it("asks for a comment when the user requests changes, and passes the abort signal", async () => {
		const signal = new AbortController().signal;
		const ui = new FakeUi({ select: ["Request changes"], input: ["more detail"] });
		assert.deepEqual(await selectReview({ arch, phase: "explore", signal }, ctx(ui)), {
			verdict: "changes",
			comment: "more detail",
		});
		assert.equal(ui.prompts[1]!.title, "What should change in Explore?");
		assert.equal(ui.prompts[0]!.signal, signal);
		assert.equal(ui.prompts[1]!.signal, signal);
	});

	it("returns nothing when the user closes either prompt", async () => {
		assert.equal(await selectReview({ arch, phase: "frame" }, ctx(new FakeUi({ select: [undefined] }))), undefined);
		const ui = new FakeUi({ select: ["Request changes"], input: [undefined] });
		assert.equal(await selectReview({ arch, phase: "frame" }, ctx(ui)), undefined);
	});
});

describe("tool rows", () => {
	it("update call lists what the arguments hold, even while they stream in", () => {
		assert.equal(updateCall(undefined, plainTheme), "◆ architect update");
		assert.equal(
			updateCall(
				{ feature: "X", modules: [{ path: "a", role: "new" }], findings: ["a", "b"], remove: ["f1"] },
				plainTheme,
			),
			'◆ architect update  "X" · 1 module · 2 findings · remove 1',
		);
		assert.match(updateCall({}, tagTheme), /<toolTitle><b>architect update<\/b><\/toolTitle>/);
	});

	it("update result is one line collapsed and one line per change expanded", () => {
		const details = { phase: "explore" as const, changes: ["+2 modules", "+1 finding (f1)"], missing: [] };
		assert.equal(
			updateResult(details, "", false, false, plainTheme),
			"✓ +2 modules · +1 finding (f1) · Explore ready for review",
		);
		assert.equal(
			updateResult(details, "", true, false, plainTheme),
			"✓ +2 modules\n✓ +1 finding (f1)\n● Explore ready for review",
		);
		assert.match(
			updateResult({ ...details, missing: ["x"] }, "", true, false, tagTheme),
			/<warning>○<\/warning> <warning>Explore needs x/,
		);
		assert.equal(updateResult(undefined, "Nothing to update.", false, true, plainTheme), "✗ Nothing to update.");
		assert.equal(updateResult(undefined, "text", false, false, plainTheme), "text");
	});

	it("advance result shows each outcome, and leaves a verdict to its banner so it shows once", () => {
		const r = (details: Parameters<typeof advanceResult>[0]) => advanceResult(details, "boom", false, plainTheme);
		assert.equal(r({ phase: "frame", outcome: "approved", next: "explore", comment: "ok" }), "");
		assert.equal(r({ phase: "blueprint", outcome: "approved", final: true, planPath: "docs/plans/x.md" }), "");
		assert.equal(r({ phase: "frame", outcome: "changes", comment: "tighten" }), "");
		assert.equal(
			r({ phase: "frame", outcome: "closed" }),
			"■ Frame review closed without a verdict · /architect review opens it again",
		);
		assert.equal(r({ phase: "slice", outcome: "not-ready", missing: ["a", "b"] }), "○ Slice not ready: needs a, b");
		assert.equal(r({ phase: "slice", outcome: "not-ready" }), "○ Slice not ready: needs ");
		assert.equal(r({ phase: "frame", outcome: "no-ui" }), "■ no interactive UI to review Frame");
		assert.equal(r(undefined), "✗ boom");
	});

	it("tool rows fit narrow widths once wrapped by Pi's Text", async () => {
		const { Text } = await import("@earendil-works/pi-tui");
		assertFits((width, theme) =>
			new Text(
				updateResult(
					{ phase: "frame", changes: ["brief: goal, 3 constraints"], missing: ["the goal"] },
					"",
					false,
					false,
					theme,
				),
				0,
				0,
			).render(width),
		);
	});
});

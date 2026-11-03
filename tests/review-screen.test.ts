import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewAnswer, ReviewRequest } from "../src/review.ts";
import type { Phase } from "../src/state/phases.ts";
import { PHASES } from "../src/state/phases.ts";
import { newArchitecture } from "../src/state/reducer.ts";
import type { Architecture } from "../src/state/types.ts";
import { GRACE_MS, InputGrace, type GraceOptions } from "../src/ui/grace.ts";
import { moduleTree } from "../src/ui/review/explore.ts";
import { createPhaseReview, phaseReview, REVIEW_BODIES, renderReview, ReviewScreen } from "../src/ui/review/index.ts";
import { reviewGeometry } from "../src/ui/review/screen.ts";
import { sliceOrder } from "../src/ui/review/slice.ts";
import { paintLine, sp } from "../src/ui/spans.ts";
import { ENTRY_TYPE, event, type EventInput } from "../src/state/events.ts";
import { harness, type BranchEntry } from "./harness.ts";
import { assertFits, FakeUi, KEYS, plain, plainTheme, tagTheme, type } from "./helpers.ts";

const o = (id: string, title: string) => ({ id, title, pros: [], cons: [], effort: 2 as const, risk: 1 as const });

export const ARCH: Architecture = {
	...newArchitecture(1, "Dedupe panel events", "dedupe-panel-events"),
	brief: {
		goal: "Operators see each panel alarm once, even when a panel resends events during a failover.",
		constraints: ["no new infrastructure", "keep the public API"],
		outOfScope: ["UI changes"],
		doneWhen: ["no duplicate alarms in the panel view", "failover test passes"],
	},
	modules: [
		{
			path: "src/ingest",
			role: "touched",
			files: ["src/ingest/processor.ts", "queue.ts", "queue.ts"],
			note: "events arrive here, and the dedupe goes in the processor before they fan out",
		},
		{ path: "src/ingest/dedupe", role: "new", files: ["window.ts"] },
		{ path: "src/api", role: "context", files: [] },
		{ path: "packages/core/src/events", role: "touched", files: [] },
	],
	findings: [
		{ id: "f1", text: "Events arrive twice during failover, with the same panel id and sequence number." },
		{ id: "f2", text: "The processor keeps per-panel state already." },
	],
	risks: [
		{ id: "r1", text: "Memory per panel", severity: "low" },
		{ id: "r2", text: "Ordering across nodes", severity: "high", mitigation: "pin panels to one node" },
	],
	decisions: [
		{
			id: "q1",
			question: "Where do panel events get deduplicated?",
			options: [o("A", "In processor"), o("B", "In backend"), o("C", "Redis stream")],
			recommendation: "A",
			chosen: "B",
			comment: "only alarms",
		},
		{
			id: "q2",
			question: "How long is the window?",
			options: [o("A", "1 minute"), o("B", "5 minutes")],
			recommendation: "A",
			chosen: "A",
		},
		{
			id: "q3",
			question: "Who owns it?",
			options: [o("A", "Us"), { ...o("B", "A gateway team"), byUser: true, summary: "the gateway team owns dedupe" }],
			chosen: "B",
		},
		{ id: "q4", question: "Log drops?", options: [o("A", "yes"), o("B", "no")] },
	],
	diagrams: [
		{
			id: "g1",
			phase: "design",
			title: "Event flow",
			body: "┌───────┐     ┌──────────────┐\n│ Panel │────▶│ Dedupe [new] │\n└───────┘     └──────────────┘",
			caption: "Dedupe sits in the processor.",
		},
		{ id: "g2", phase: "explore", title: "Today", body: "Panel ──▶ Processor" },
	],
	slices: [
		{
			id: "s2",
			title: "Wire into processor",
			dependsOn: ["s1"],
			files: ["src/ingest/processor.ts"],
			steps: ["call it"],
			verify: ["npm test"],
		},
		{
			id: "s1",
			title: "Dedupe window",
			goal: "A window drops repeats.",
			dependsOn: [],
			files: ["window.ts"],
			steps: ["add", "test"],
			verify: ["npm test -- window", "npm run lint"],
		},
		{ id: "s3", title: "Docs", dependsOn: [], files: [], steps: [], verify: [] },
	],
};

/** A screen without the input grace period unless `grace` says otherwise, so keys land at once. */
function screen(
	phase: Phase,
	arch: Architecture = ARCH,
	rows = 200,
	summary?: string,
	grace: GraceOptions = { graceMs: 0 },
) {
	const answers: (ReviewAnswer | undefined)[] = [];
	const request: ReviewRequest = { arch, phase, ...(summary ? { summary } : {}) };
	const component = new ReviewScreen(
		{ requestRender() {}, terminal: { rows } } as never,
		plainTheme,
		request,
		REVIEW_BODIES[phase],
		(a) => answers.push(a),
		grace,
	);
	component.focused = true;
	const keys = (...data: string[]) => data.forEach((d) => component.handleInput(d));
	return { component, answers, keys, lines: (w = 80) => plain(component.render(w)) };
}

const text = (phase: Phase, width = 80, arch = ARCH) => screen(phase, arch).lines(width).join("\n");

describe("phase review screens", () => {
	it("fit every width from 30 to 200, for every phase, browsing and writing", () => {
		for (const phase of PHASES) {
			const s = screen(phase, ARCH, 30, "Check the scope, and say what is missing before we move on.");
			assertFits((w) => s.component.render(w), [30, 40, 80, 120, 200]);
			s.keys("r", ...type("a long comment that wraps"));
			assertFits((w) => s.component.render(w), [30, 40, 80, 120, 200]);
		}
	});

	it("frame the body with the phase, the feature, the agent's summary and the verdict keys", () => {
		const lines = screen("frame", ARCH, 200, "Check the scope.").lines(80);
		assert.match(lines[0]!, /^╭─ ◆ Review Frame 1\/6 ─+ Dedupe panel events ─╮$/);
		assert.match(lines[2]!, /^│ {2}▍ Check the scope\. +│$/);
		assert.match(lines[3]!, /^├─+┤$/);
		assert.match(lines.at(-2)!, /↵ approve Frame {2}r request changes {2}esc close/);
		assert.match(lines.at(-1)!, /^╰─+╯$/);
		assert.ok(!screen("frame").lines(80)[2]!.includes("▍"), "no summary row without a summary");
	});

	it("Frame shows the brief as a card, constraints beside out of scope when wide", () => {
		const wide = text("frame");
		assert.match(wide, /GOAL/);
		assert.match(wide, /Operators see each panel alarm once/);
		assert.match(wide, /CONSTRAINTS +OUT OF SCOPE/);
		assert.match(wide, /• no new infrastructure +× UI changes/);
		assert.match(wide, /☐ no duplicate alarms in the panel view/);
		assert.match(wide, /RISKS +2 risks/);
		assert.ok(wide.indexOf("Ordering across nodes") < wide.indexOf("Memory per panel"), "high risks first");
		assert.match(wide, /↳ pin panels to one node/);
		const narrow = text("frame", 40);
		assert.doesNotMatch(narrow, /CONSTRAINTS +OUT OF SCOPE/);
		assert.match(narrow, /OUT OF SCOPE/);
		const empty = text("frame", 80, newArchitecture(1));
		assert.match(empty, /not set/);
		assert.match(empty, /• none|none/);
		assert.doesNotMatch(empty, /RISKS/);
	});

	it("Explore shows the module map as a tree with markers, the findings and its diagrams", () => {
		const t = text("explore", 100);
		assert.match(t, /MODULES +● touched {2}\+ new {2}○ context/);
		assert.match(t, /src\//);
		assert.match(t, /├─ ● ingest\//);
		assert.match(t, /│ {2}├─ processor\.ts/);
		assert.match(t, /│ {2}└─ \+ dedupe\//);
		assert.match(t, /│ {5}└─ window\.ts/);
		assert.match(t, /└─ ○ api/);
		assert.match(t, /● packages\/core\/src\/events/);
		assert.equal((t.match(/queue\.ts/g) ?? []).length, 1, "files are listed once");
		assert.match(t, /f1 {2}Events arrive twice/);
		assert.match(t, /DIAGRAMS/);
		assert.match(t, /Today/);
		assert.doesNotMatch(t, /Event flow/);
		const narrow = text("explore", 40);
		assert.match(narrow, /│ {2}│ {2}events arrive here/, "a long note wraps under its module");
		assert.match(text("explore", 80, newArchitecture(1)), /no modules yet/);
		const tree = moduleTree([{ path: "a/b", role: "new", files: [] }]);
		assert.equal(tree.children[0]!.name, "a/b");
	});

	it("Decide shows each decision with the choice, the comment and the rejected options", () => {
		const t = text("decide");
		assert.match(t, /DECISIONS +3 decided · 1 open/);
		assert.match(t, /q1 {2}Where do panel events get deduplicated\?/);
		assert.match(t, /✓ B {2}In backend\s/);
		assert.match(t, /"only alarms"/);
		assert.match(t, /A In processor ★ · C Redis stream/);
		assert.match(t, /✓ A {2}1 minute ★/);
		assert.match(t, /✓ B {2}A gateway team {2}your own option/);
		assert.match(t, /the gateway team owns dedupe/);
		assert.match(t, /q4 {2}Log drops\?\s+│\n│\s+○ open/);
		assert.match(text("decide", 80, newArchitecture(1)), /No open questions/);
		const done = { ...ARCH, decisions: ARCH.decisions.slice(0, 2) };
		assert.match(text("decide", 80, done), /DECISIONS +2 decided +│/);
	});

	it("Decide and Blueprint show an option the user wrote as their own, never with placeholder ratings", () => {
		for (const phase of ["decide", "blueprint"] as const) {
			const t = text(phase);
			assert.match(t, /A gateway team {2}your own option/);
			assert.doesNotMatch(t, /effort|risk [▰\d]|3\/5/);
		}
		const narrow = text("decide", 30);
		assert.match(
			narrow,
			/A gateway team\s+│\n│\s+your own option/,
			"the tag moves below a title it does not fit beside",
		);
	});

	it("Design shows the design diagrams through the diagram renderer", () => {
		const t = text("design");
		assert.match(t, /DIAGRAMS +1 diagram/);
		assert.match(t, /╭─ Event flow/);
		assert.match(t, /│ Panel │────▶│ Dedupe \[new\] │/);
		assert.match(t, /Dedupe sits in the processor\./);
		assert.match(text("design", 80, newArchitecture(1)), /No diagrams/);
		const two = { ...ARCH, diagrams: [ARCH.diagrams[0]!, { ...ARCH.diagrams[0]!, id: "g3", title: "Second" }] };
		assert.match(text("design", 80, two), /2 diagrams/);
	});

	it("Slice shows the slices in build order with arrows, files, steps and verify", () => {
		const t = text("slice");
		assert.match(t, /SLICES +3 slices · build order/);
		assert.ok(t.indexOf("s1  Dedupe window") < t.indexOf("s2  Wire into processor"));
		assert.match(t, /● s2 {2}Wire into processor {2}← s1/);
		assert.match(t, /│ {3}A window drops repeats\./);
		assert.match(t, /│ {3}steps {3}1\. add/);
		assert.match(t, /│ {11}2\. test/);
		assert.match(t, /│ {3}verify {2}npm test -- window/);
		assert.match(t, /│ {2}▼ +│/);
		assert.match(t, /verify {2}missing/);
		const broken = { ...ARCH, slices: [{ ...ARCH.slices[2]!, dependsOn: ["s9"] }] };
		assert.match(text("slice", 80, broken), /✗ s3 depends on unknown slice s9/);
		assert.match(text("slice", 80, newArchitecture(1)), /no slices yet/);
		const cycle = [
			{ ...ARCH.slices[2]!, id: "x", dependsOn: ["y"] },
			{ ...ARCH.slices[2]!, id: "y", dependsOn: ["x"] },
		];
		assert.deepEqual(
			sliceOrder(cycle).map((s) => s.id),
			["x", "y"],
		);
	});

	it("Blueprint shows the whole design on one page, and where approving writes the plan", () => {
		const s = screen("blueprint", ARCH, 200);
		const t = s.lines(100).join("\n");
		assert.match(t, /▣ Dedupe panel events/);
		assert.match(t, /4 modules · 4 decisions · 1 open · 2 diagrams · 3 slices in 2 steps · ⚠ 2 risks/);
		for (const heading of ["BRIEF", "CONSTRAINTS", "DONE WHEN", "MODULES", "DECISIONS", "DESIGN", "SLICES", "RISKS"])
			assert.match(t, new RegExp(heading));
		assert.ok(t.indexOf("s1  Dedupe window") < t.indexOf("s2  Wire into processor"), "build order");
		assert.match(t, /╭─ Event flow/);
		assert.doesNotMatch(t, /Approving writes/);
		assert.match(t, /Approving the Blueprint makes the plan final\./);
		const withPath = new ReviewScreen(
			{ requestRender() {}, terminal: { rows: 200 } } as never,
			plainTheme,
			{ arch: ARCH, phase: "blueprint", planPath: "docs/plans/dedupe-panel-events.md" },
			REVIEW_BODIES.blueprint,
			() => {},
		);
		assert.match(plain(withPath.render(100)).join("\n"), /Approving writes docs\/plans\/dedupe-panel-events\.md/);
		const narrow = plain(withPath.render(40)).join("\n");
		assert.match(narrow, /4 modules · 4 decisions · 1 open\s+│\n│\s+2 diagrams/, "the counts wrap");
		const bare = text("blueprint", 80, newArchitecture(1));
		assert.match(bare, /▣ Unnamed feature/);
		assert.match(bare, /no goal/);
		assert.match(bare, /0 modules · 0 decisions · 0 diagrams · 0 slices/);
		assert.doesNotMatch(bare, /MODULES|DECISIONS|DESIGN|build order/);
		const calm = { ...ARCH, risks: [ARCH.risks[0]!], slices: [ARCH.slices[2]!] };
		assert.match(text("blueprint", 100, calm), /1 slice · ⚠ 1 risk/);
	});

	it("Blueprint review tells where the plan goes, from architect_advance", async () => {
		const entry = (input: EventInput): BranchEntry => ({ type: "custom", customType: ENTRY_TYPE, data: event(input) });
		const branch = [
			entry({ type: "begin", feature: "Dedupe", slug: "dedupe", at: 1 }),
			entry({ type: "mode", mode: "architect", at: 2 }),
			...(["frame", "explore", "decide", "design", "slice"] as const).map((phase, i) =>
				entry({ type: "verdict", phase, verdict: "approved", at: 3 + i }),
			),
		];
		const ui = new FakeUi().keys([KEYS.escape]);
		const h = harness({ ui, branch, builtins: ["read"] });
		await h.fire("session_start", { reason: "resume" });
		await h.call("architect_advance", {});
		assert.match(ui.customs[0]!.frames[0]!.join("\n"), /Approving writes docs\/plans\/dedupe\.md/);
	});

	it("colours the markers and the scrollbar with the theme", () => {
		const c = new ReviewScreen(
			{ requestRender() {}, terminal: { rows: 14 } } as never,
			tagTheme,
			{ arch: ARCH, phase: "explore" },
			REVIEW_BODIES.explore,
			() => {},
		);
		const t = c.render(100).join("\n");
		assert.match(t, /<warning>● <\/warning><text><b>ingest\/<\/b><\/text>/);
		assert.match(t, /<success>\+ <\/success><success><b>dedupe\/<\/b><\/success>/);
		const tall = new ReviewScreen(
			{ requestRender() {}, terminal: { rows: 200 } } as never,
			tagTheme,
			{ arch: ARCH, phase: "explore" },
			REVIEW_BODIES.explore,
			() => {},
		);
		assert.match(tall.render(100).join("\n"), /<dim>○ <\/dim><muted>api<\/muted>/);
		assert.doesNotMatch(t, /<borderMuted><\/borderMuted>/, "no empty styles");
		assert.match(t, /<accent>┃<\/accent>/);
		assert.match(t, /<accent><b>MODULES<\/b><\/accent>/);
	});
});

describe("phase review keys", () => {
	it("scrolls long bodies with arrows, pages, home and end, and shows where it is", () => {
		const s = screen("slice", ARCH, 20);
		let lines = s.lines(80);
		assert.equal(lines.length, 16);
		assert.match(lines.at(-1)!, /↓ \d+ more ─╯$/);
		assert.ok(
			lines.some((l) => l.endsWith("┃")),
			"scrollbar thumb",
		);
		assert.match(lines.at(-2)!, /↑↓ scroll/);
		s.keys(KEYS.down, "j");
		assert.equal(s.component.state.scroll, 2);
		lines = s.lines(80);
		assert.match(lines.at(-1)!, /↑ 2 · ↓ \d+ more/);
		s.keys(KEYS.up, "k", KEYS.up);
		assert.equal(s.component.state.scroll, 0);
		s.keys(KEYS.pageDown);
		assert.ok(s.component.state.scroll > 2);
		s.keys(KEYS.end);
		s.lines(80);
		const end = s.component.state.scroll;
		s.keys(" ");
		assert.equal(s.component.state.scroll, end);
		assert.match(s.lines(80).at(-1)!, /↑ \d+ ─╯$/);
		s.keys(KEYS.pageUp, KEYS.home);
		assert.equal(s.component.state.scroll, 0);
		assert.deepEqual(s.answers, []);
	});

	it("does not scroll a body that fits", () => {
		const s = screen("decide");
		s.keys(KEYS.down);
		assert.equal(s.component.state.scroll, 0);
		assert.doesNotMatch(s.lines(80).join("\n"), /scroll/);
	});

	it("↵ approves", () => {
		const s = screen("frame");
		s.keys(KEYS.enter);
		assert.deepEqual(s.answers, [{ verdict: "approved" }]);
	});

	it("r opens a comment editor; ↵ sends the changes, empty text does nothing", () => {
		const s = screen("frame");
		s.keys("r");
		assert.equal(s.component.state.mode, "changes");
		const lines = s.lines(80);
		assert.ok(lines.some((l) => l.includes("What should change in Frame?")));
		assert.ok(lines.some((l) => l.includes("↵ send  shift+↵ new line  esc back")));
		s.keys(KEYS.enter);
		assert.deepEqual(s.answers, []);
		s.keys(...type(" tighten it "), KEYS.enter);
		assert.deepEqual(s.answers, [{ verdict: "changes", comment: "tighten it" }]);
	});

	it("esc steps back from the editor keeping the draft, and closes the screen", () => {
		const s = screen("frame");
		s.keys("r", ...type("draft"), KEYS.escape);
		assert.equal(s.component.state.mode, "browse");
		s.keys("r");
		assert.ok(s.lines(80).some((l) => l.includes("draft")));
		s.component.focused = false;
		assert.equal(s.component.focused, false);
		s.component.focused = true;
		s.keys(KEYS.escape, "x", KEYS.escape);
		assert.deepEqual(s.answers, [undefined]);
	});

	it("draws the body again after invalidate", () => {
		let calls = 0;
		const c = new ReviewScreen(
			{ requestRender() {}, terminal: { rows: 40 } } as never,
			plainTheme,
			{ arch: ARCH, phase: "frame" },
			() => {
				calls++;
				return [[sp("x")]];
			},
			() => {},
		);
		c.render(80);
		c.render(80);
		assert.equal(calls, 1);
		c.invalidate();
		c.render(80);
		assert.equal(calls, 2);
	});
});

describe("the review screen entry point", () => {
	it("runs inline and reports Pi as waiting", async () => {
		const ui = new FakeUi().keys([KEYS.enter]);
		const answer = await createPhaseReview({}, { graceMs: 0 })({ arch: ARCH, phase: "decide" }, {
			mode: "tui",
			ui,
		} as never);
		assert.deepEqual(answer, { verdict: "approved" });
		assert.deepEqual(ui.customs[0]!.options, { blocked: { kind: "question", message: "Review Decide" } });
	});

	it("takes other bodies, e.g. the Blueprint screen", async () => {
		const review = createPhaseReview({ blueprint: () => [[sp("THE BLUEPRINT")]] });
		const ui = new FakeUi().keys([KEYS.escape]);
		assert.equal(await review({ arch: ARCH, phase: "blueprint" }, { mode: "tui", ui } as never), undefined);
		assert.ok(ui.customs[0]!.frames[0]!.some((l) => l.includes("THE BLUEPRINT")));
	});

	it("closes on interrupt, also when already interrupted", async () => {
		const controller = new AbortController();
		const ui = new FakeUi().keys([() => controller.abort(), KEYS.enter]);
		const signal = controller.signal;
		assert.equal(await phaseReview({ arch: ARCH, phase: "frame", signal }, { mode: "tui", ui } as never), undefined);
		const ui2 = new FakeUi().keys([]);
		assert.equal(
			await phaseReview({ arch: ARCH, phase: "frame", signal }, { mode: "tui", ui: ui2 } as never),
			undefined,
		);
	});

	it("falls back to the select dialog outside the terminal", async () => {
		const ui = new FakeUi({ select: ["Approve Frame"] });
		assert.deepEqual(await phaseReview({ arch: ARCH, phase: "frame" }, { mode: "rpc", ui } as never), {
			verdict: "approved",
		});
	});

	it("keeps a minimum viewport on short terminals and caps the width", () => {
		const body = Array.from({ length: 50 }, (_, i) => [sp(`line ${i}`)]);
		const layout = renderReview({ phase: "frame", body, scroll: 99, mode: "browse", maxRows: 5 }, 300);
		assert.equal(layout.viewport, 3);
		assert.equal(layout.scroll, layout.maxScroll);
		assert.equal(paintLine(layout.lines[0]!, plainTheme).length, 120);
		assert.equal(reviewGeometry(50).padX, 1);
		const changes = renderReview({ phase: "frame", body, scroll: 0, mode: "changes" }, 80);
		assert.ok(changes.lines.some((l) => paintLine(l, plainTheme).includes("What should change")));
	});
});

describe("review screen grace period", () => {
	it("lasts 300 ms by default", () => {
		let t = 5_000;
		const grace = new InputGrace({ now: () => t });
		assert.equal(GRACE_MS, 300);
		assert.equal(grace.active, true);
		t += 299;
		assert.equal(grace.active, true);
		t += 1;
		assert.equal(grace.active, false);
		assert.equal(new InputGrace({ now: () => t, graceMs: 0 }).active, false);
	});

	it("ignores ↵ and r for 300 ms after it opens, while scrolling still works", () => {
		let t = 0;
		const s = screen("blueprint", ARCH, 14, undefined, { now: () => t });
		s.lines(80);
		s.keys(KEYS.enter, "r");
		assert.deepEqual(s.answers, [], "a stray ↵ does not approve");
		assert.equal(s.component.state.mode, "browse", "no editor opens");
		s.keys(KEYS.down, KEYS.down);
		assert.equal(s.component.state.scroll, 2);
		t = 300;
		s.keys(KEYS.enter);
		assert.deepEqual(s.answers, [{ verdict: "approved" }]);
	});

	it("still closes with esc during the grace period", () => {
		const s = screen("frame", ARCH, 200, undefined, { now: () => 0 });
		s.keys(KEYS.escape);
		assert.deepEqual(s.answers, [undefined]);
	});

	it("the extension uses its clock, so a ↵ right after architect_advance does not approve", async () => {
		const entry = (input: EventInput): BranchEntry => ({ type: "custom", customType: ENTRY_TYPE, data: event(input) });
		let t = 10_000;
		const ui = new FakeUi().keys([KEYS.enter, () => (t += 300), KEYS.enter]);
		const h = harness({
			ui,
			branch: [
				entry({ type: "begin", feature: "Dedupe", slug: "dedupe", at: 1 }),
				entry({ type: "mode", mode: "architect", at: 2 }),
			],
			overrides: { now: () => t, inputGrace: 300 },
		});
		await h.fire("session_start", { reason: "resume" });
		await h.call("architect_update", { brief: { goal: "g", doneWhen: ["d"] } });
		await h.call("architect_advance", {});
		assert.equal(ui.customs[0]!.frames.length, 3, "the first ↵ was ignored");
		assert.equal(h.entries.filter((e) => e.data.type === "verdict").length, 1);
	});
});

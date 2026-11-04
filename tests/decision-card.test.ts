import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { DecisionAnswer, DecisionRequest } from "../src/decision.ts";
import type { Decision, DecisionOption } from "../src/state/types.ts";
import { chooseLayout, frameWidth, renderDecision, split } from "../src/ui/decision/card.ts";
import { createDecisionCard, DecisionCard } from "../src/ui/decision/index.ts";
import type { ScreenOptions } from "../src/ui/screen-options.ts";
import { paintLine } from "../src/ui/spans.ts";
import { ansiTheme, assertFits, FakeUi, KEYS, plain, plainTheme, tagTheme, type } from "./helpers.ts";

const option = (id: string, title: string, over: Partial<DecisionOption> = {}): DecisionOption => ({
	id,
	title,
	pros: [`${title} pro`],
	cons: [`${title} con`],
	effort: 2,
	risk: 1,
	...over,
});

const DECISION: Decision = {
	id: "q3",
	question: "Where do panel events get deduplicated?",
	context: "Panels resend every event during a failover.",
	options: [
		option("A", "In processor", { summary: "Drop repeats as they stream in.", effort: 2, risk: 1 }),
		option("B", "In backend", { effort: 3, risk: 2 }),
		option("C", "Redis stream", { effort: 4, risk: 5 }),
	],
	recommendation: "A",
	reason: "One owner, no new infra.",
};

const FOUR: Decision = { ...DECISION, options: [...DECISION.options, option("D", "Client side")] };

/** A card without the input grace period unless `grace` says otherwise, so keys land at once. */
function card(request: Partial<DecisionRequest> = {}, rows = 200, grace: ScreenOptions = { graceMs: 0 }) {
	const answers: (DecisionAnswer | undefined)[] = [];
	let renders = 0;
	const tui = { requestRender: () => renders++, terminal: { rows } };
	const component = new DecisionCard(
		tui as never,
		plainTheme,
		{ decision: DECISION, index: 3, total: 5, feature: "Dedupe", ...request },
		(a) => answers.push(a),
		grace,
	);
	component.focused = true;
	const keys = (...data: string[]) => data.forEach((d) => component.handleInput(d));
	const lines = (width = 100) => plain(component.render(width));
	return { component, answers, keys, lines, renders: () => renders };
}

describe("decision card layout", () => {
	it("puts the options side by side when they fit, two by two, or folds them into a list", () => {
		assert.deepEqual(chooseLayout(3, 94), { kind: "row", columns: 3 });
		assert.deepEqual(chooseLayout(4, 74), { kind: "grid", columns: 2 });
		assert.deepEqual(chooseLayout(3, 60), { kind: "list" });
		assert.deepEqual(chooseLayout(2, 40), { kind: "list" });
		assert.deepEqual(split(10, 3), [4, 3, 3]);
		assert.equal(frameWidth(2, 200), 88);
		assert.equal(frameWidth(2, 50), 50);
		assert.equal(frameWidth(4, 200), 172);
	});

	it("draws the mock-up at 100 columns: header, question, cards, recommendation and hints", () => {
		const lines = card().lines(100);
		assert.match(lines[0]!, /^╭─ ◆ Decision 3\/5 ─+ Dedupe ─╮$/);
		assert.match(lines[2]!, /│ {2}Where do panel events get deduplicated\? +│/);
		assert.match(lines[3]!, /Panels resend every event during a failover\./);
		const top = lines.find((l) => l.includes("┏━ A  In processor ★"))!;
		assert.match(top, /┏━ A {2}In processor ★ ━+┓ {2}┌─ B {2}In backend ─+┐ {2}┌─ C {2}Redis stream ─+┐/);
		const efforts = lines.filter((l) => l.includes("effort"));
		assert.equal(efforts.length, 1, "the meters line up across the cards");
		assert.match(efforts[0]!, /effort ▰▰▱▱▱ .*effort ▰▰▰▱▱ .*effort ▰▰▰▰▱/);
		assert.ok(lines.some((l) => /\+ In processor pro .*\+ In backend pro/.test(l)));
		assert.ok(lines.some((l) => /− In processor con/.test(l)));
		assert.ok(lines.some((l) => l.includes("★ Agent recommends A  In processor")));
		assert.ok(lines.some((l) => l.includes("One owner, no new infra.")));
		assert.ok(
			lines.some((l) => l.includes("↵ choose  c choose with comment  n own option  ? ask  ←→ move  esc close")),
		);
		assert.match(lines.at(-1)!, /^╰─+╯$/);
	});

	it("folds into a list with the focused option open on narrow terminals", () => {
		const lines = card().lines(40);
		assert.ok(lines.some((l) => l.includes("┏━ A  In processor ★")));
		assert.ok(lines.some((l) => /│ {3}B {2}In backend +e ▰▰▰▱▱ r ▰▰▱▱▱ │/.test(l)));
		assert.ok(lines.some((l) => l.includes("↑↓ move")));
		assert.ok(!lines.some((l) => l.includes("┌─ B")));
		const narrow = card().lines(30);
		assert.ok(
			narrow.some((l) => /│ {3}B {2}In backend +│/.test(l)),
			"drops the meters when they do not fit",
		);
		assert.ok(
			narrow.some((l) => l.includes("★ A  In processor")),
			"shortens the recommendation",
		);
	});

	it("shows four options two by two at 80 columns", () => {
		const lines = card({ decision: FOUR }).lines(80);
		assert.equal(lines.filter((l) => l.includes("┏━ A") || l.includes("┌─ C")).length, 2);
		assert.ok(lines.some((l) => /┌─ C {2}Redis stream ─+┐ {2}┌─ D {2}Client side/.test(l)));
	});

	it("fits every width from 30 to 200, in every mode", () => {
		const widths = [30, 40, 60, 80, 100, 120, 160, 200];
		for (const decision of [DECISION, FOUR, { ...DECISION, options: DECISION.options.slice(0, 2) }]) {
			const c = card({ decision }, 200, { graceMs: 0, board: () => {} });
			assertFits((w) => c.component.render(w), widths);
			c.keys("c", ...type("a comment that is long enough to wrap in a narrow card"));
			assertFits((w) => c.component.render(w), widths);
		}
	});

	it("moves the titles into the cards when they do not fit in the border", () => {
		const long = {
			...DECISION,
			options: [
				option("A", "Deduplicate in the stream processor with a window"),
				option("B", "Deduplicate in the backend"),
			],
		};
		const lines = card({ decision: long }).lines(80);
		assert.ok(lines.some((l) => /┏━ A ━+┓/.test(l)));
		assert.ok(lines.some((l) => l.includes("★ recommended")));
		assert.ok(lines.some((l) => l.includes("Deduplicate in the")));
		const list = card({ decision: long }).lines(40);
		assert.ok(list.some((l) => /┏━ A ━+┓/.test(l)));
	});

	it("folds into a list when the cards would not fit the terminal's height", () => {
		const tall = card({}, 20).lines(100);
		assert.ok(tall.some((l) => /│ {4}B {2}In backend +effort ▰▰▰▱▱ {2}risk ▰▰▱▱▱ +│/.test(l)));
		const roomy = card({}, 60).lines(100);
		assert.ok(roomy.some((l) => l.includes("┌─ B")));
	});

	it("leaves out what it does not know", () => {
		const bare = renderDecision(
			{ decision: { id: "q1", question: "Q?", options: DECISION.options.slice(0, 2) }, focus: 1, mode: "browse" },
			80,
		).map((l) => paintLine(l, plainTheme));
		assert.match(bare[0]!, /^╭─ ◆ Decision ─+╮$/);
		assert.ok(!bare.some((l) => l.includes("★")));
		assert.ok(bare.some((l) => l.includes("┏━ B")));
		const unsure = renderDecision({ decision: DECISION, focus: 0, mode: "browse", index: 6, total: 5 }, 80);
		assert.match(paintLine(unsure[0]!, plainTheme), /Decision 6\/6/);
		const noReason = { ...DECISION, reason: undefined } as unknown as Decision;
		const lines = renderDecision({ decision: noReason, focus: 0, mode: "browse" }, 80).map((l) =>
			paintLine(l, plainTheme),
		);
		assert.ok(!lines.some((l) => l.includes("One owner")));
	});

	it("shows an own option as not rated", () => {
		const own = { ...DECISION, options: [...DECISION.options.slice(0, 2), option("C", "Mine", { byUser: true })] };
		assert.ok(
			card({ decision: own })
				.lines(100)
				.some((l) => l.includes("your own option")),
		);
		const c = card({ decision: own });
		c.keys("3");
		assert.ok(c.lines(40).some((l) => l.includes("your own option")));
		assert.ok(
			card({ decision: own })
				.lines(40)
				.some((l) => /C {2}Mine +your own/.test(l)),
		);
	});

	it("colours the focused card, the star, the meters, pros and cons", () => {
		const c = new DecisionCard(
			{ requestRender() {}, terminal: { rows: 200 } } as never,
			tagTheme,
			{ decision: DECISION },
			() => {},
		);
		const text = c.render(100).join("\n");
		assert.match(text, /<borderAccent>┏━<\/borderAccent>/);
		assert.match(text, /<borderMuted>┌─<\/borderMuted>/);
		assert.match(text, /<warning> ★<\/warning>/);
		assert.match(text, /<success>▰▰<\/success><dim>▱▱▱<\/dim>/);
		assert.match(text, /<warning>▰▰▰<\/warning>/);
		assert.match(text, /<error>▰▰▰▰▰<\/error>/);
		assert.match(text, /<success>\+ <\/success><text>In processor pro<\/text>/);
		assert.match(text, /<warning>− <\/warning><text>In processor con<\/text>/);
		assert.match(text, /<muted>↵<\/muted><dim> choose<\/dim>/);
		assert.match(text, /<accent><b>◆<\/b><\/accent>/);
	});

	it("paints again after invalidate, so a theme change shows", () => {
		let dark = true;
		const theme = { fg: (_c: string, t: string) => (dark ? `\x1b[2m${t}\x1b[22m` : t), bold: (t: string) => t };
		const c = new DecisionCard(
			{ requestRender() {}, terminal: { rows: 200 } } as never,
			theme,
			{ decision: DECISION },
			() => {},
		);
		const before = c.render(80);
		assert.equal(c.render(80), before, "cached per width");
		dark = false;
		assert.equal(c.render(80), before);
		c.invalidate();
		assert.notDeepEqual(c.render(80), before);
		assert.notEqual(c.render(81), c.render(80));
		assert.equal(visibleWidth(ansiTheme.fg("accent", "x")), 1);
	});
});

describe("decision card keys", () => {
	it("starts on the recommendation; arrows, tab and digits move with wrap-around", () => {
		const c = card();
		assert.deepEqual(c.component.state, { focus: "A", mode: "browse" });
		c.keys(KEYS.right);
		assert.equal(c.component.state.focus, "B");
		c.keys(KEYS.tab, KEYS.tab);
		assert.equal(c.component.state.focus, "A");
		c.keys(KEYS.left);
		assert.equal(c.component.state.focus, "C");
		c.keys(KEYS.shiftTab, KEYS.up);
		assert.equal(c.component.state.focus, "A");
		c.keys(KEYS.down, "3");
		assert.equal(c.component.state.focus, "C");
		c.keys("4", "x");
		assert.equal(c.component.state.focus, "C", "4 does nothing with three options");
		assert.ok(c.renders() >= 6);
		assert.ok(c.lines(100).some((l) => l.includes("┏━ C  Redis stream")));
		c.keys(KEYS.enter);
		assert.deepEqual(c.answers, [{ kind: "choose", option: "C" }]);
	});

	it("starts on the first option without a recommendation", () => {
		const { recommendation: _r, ...open } = DECISION;
		assert.equal(card({ decision: open }).component.state.focus, "A");
	});

	it("c opens a comment editor for the focused option; ↵ chooses it with the comment", () => {
		const c = card();
		c.keys(KEYS.right, "c");
		assert.equal(c.component.state.mode, "comment");
		const lines = c.lines(100);
		assert.ok(lines.some((l) => l.includes("Your comment on B In backend")));
		assert.ok(lines.some((l) => l.includes("↵ send  shift+↵ new line  esc back")));
		c.keys(...type("only alarms"));
		assert.ok(c.lines(100).some((l) => l.includes("only alarms")));
		c.keys(KEYS.enter);
		assert.deepEqual(c.answers, [{ kind: "choose", option: "B", comment: "only alarms" }]);
	});

	it("an empty comment chooses without one", () => {
		const c = card();
		c.keys("c", " ", KEYS.enter);
		assert.deepEqual(c.answers, [{ kind: "choose", option: "A" }]);
	});

	it("n proposes an own option and ? asks a question; empty text does nothing", () => {
		const c = card();
		c.keys("n");
		assert.ok(c.lines(100).some((l) => l.includes("Your own option")));
		c.keys(KEYS.enter);
		assert.deepEqual(c.answers, []);
		c.keys(...type("a gateway"), KEYS.enter);
		assert.deepEqual(c.answers, [{ kind: "own", text: "a gateway" }]);
		const q = card();
		q.keys("?");
		assert.ok(q.lines(100).some((l) => l.includes("Your question for the agent")));
		q.keys(...type("why not B?"), KEYS.enter);
		assert.deepEqual(q.answers, [{ kind: "ask", question: "why not B?" }]);
	});

	it("esc steps back from an editor and keeps the draft; esc again closes", () => {
		const c = card();
		c.keys("n", ...type("draft"), KEYS.escape);
		assert.deepEqual(c.component.state, { focus: "A", mode: "browse" });
		assert.deepEqual(c.answers, []);
		c.keys("n");
		assert.ok(c.lines(100).some((l) => l.includes("draft")));
		c.keys(KEYS.escape, KEYS.escape);
		assert.deepEqual(c.answers, [undefined]);
	});

	it("passes focus to the editor so the cursor shows", () => {
		const c = card();
		c.keys("c");
		c.component.focused = false;
		assert.equal(c.component.focused, false);
		assert.ok(!c.component.render(80).join("").includes("\x1b_pi:c"));
		c.component.focused = true;
		c.component.invalidate();
		assert.ok(c.component.render(80).join("").includes("\x1b_pi:c"));
	});
});

describe("decision card grace period", () => {
	it("ignores ↵, c, n and ? for 300 ms after it opens, while the arrows still move", () => {
		let t = 1_000;
		const c = card({}, 200, { now: () => t });
		c.keys(KEYS.enter, "c", "n", "?");
		assert.deepEqual(c.answers, [], "a stray ↵ does not choose");
		assert.equal(c.component.state.mode, "browse", "no editor opens");
		c.keys(KEYS.right, "3");
		assert.equal(c.component.state.focus, "C");
		t += 299;
		c.keys(KEYS.enter);
		assert.deepEqual(c.answers, []);
		t += 1;
		c.keys(KEYS.enter);
		assert.deepEqual(c.answers, [{ kind: "choose", option: "C" }]);
	});

	it("opens the board with b, also during the grace period, and keeps the focus", () => {
		let boards = 0;
		const c = card({}, 200, { now: () => 0, board: () => boards++ });
		assert.match(
			c.lines(100).join("\n"),
			/↵ choose {2}c choose with comment {2}n own option {2}\? ask {2}←→ move {2}b board {2}esc close/,
		);
		assert.match(c.lines(50).join("\n"), /b board/);
		c.keys(KEYS.right, "b");
		assert.equal(boards, 1);
		assert.deepEqual(c.answers, []);
		assert.deepEqual(c.component.state, { focus: "B", mode: "browse" });
		assert.doesNotMatch(card().lines(100).join("\n"), /b board/);
	});

	it("types b in an editor instead of opening the board", () => {
		let boards = 0;
		const c = card({}, 200, { graceMs: 0, board: () => boards++ });
		c.keys("?", "b", KEYS.enter);
		assert.equal(boards, 0);
		assert.deepEqual(c.answers, [{ kind: "ask", question: "b" }]);
	});

	it("still closes with esc during the grace period", () => {
		const c = card({}, 200, { now: () => 0 });
		c.keys(KEYS.escape);
		assert.deepEqual(c.answers, [undefined]);
	});

	it("gets its clock and length from the factory", async () => {
		let t = 0;
		const ui = new FakeUi().keys([KEYS.enter, () => (t = 50), KEYS.enter]);
		const answer = await createDecisionCard({ now: () => t, graceMs: 50 })({ decision: DECISION }, {
			mode: "tui",
			ui,
		} as never);
		assert.deepEqual(answer, { kind: "choose", option: "A" });
		assert.equal(ui.customs[0]!.frames.length, 3, "the first ↵ was ignored");
	});
});

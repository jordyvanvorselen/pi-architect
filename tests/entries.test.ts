import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ENTRY_TYPE, event, type ChoiceEvent, type EventInput, type VerdictEvent } from "../src/state/events.ts";
import type { Decision } from "../src/state/types.ts";
import { choiceEntry, SpanView, verdictEntry } from "../src/ui/entries.ts";
import { harness, type BranchEntry } from "./harness.ts";
import { assertFits, plain, plainTheme, tagTheme } from "./helpers.ts";

const o = (id: string, title: string) => ({ id, title, pros: [], cons: [], effort: 3 as const, risk: 2 as const });
const DECISION: Decision = {
	id: "q1",
	question: "Where do panel events get deduplicated?",
	options: [o("A", "In processor"), o("B", "In backend"), { ...o("C", "Mine"), byUser: true }],
	recommendation: "A",
	chosen: "B",
};
const choice = (over: Partial<ChoiceEvent> = {}): ChoiceEvent => ({
	v: 1,
	type: "choice",
	id: "q1",
	chosen: "B",
	comment: "only alarms",
	...over,
});
const verdict = (over: Partial<VerdictEvent> = {}): VerdictEvent => ({
	v: 1,
	type: "verdict",
	phase: "frame",
	verdict: "approved",
	at: 1,
	...over,
});
const { comment: _comment, ...noComment } = choice();
const lines = (draw: (w: number) => unknown, width = 80) =>
	plain(new SpanView(plainTheme, draw as never).render(width)).map((l) => l.trimEnd());

describe("transcript cards", () => {
	it("a choice is one line collapsed and a small card expanded", () => {
		assert.deepEqual(lines(choiceEntry(choice(), DECISION, false), 120), [
			'◆ q1 ✓ B In backend  "only alarms" · Where do panel events get deduplicated?',
		]);
		assert.deepEqual(lines(choiceEntry(choice(), DECISION, true)), [
			"◆ q1  Where do panel events get deduplicated?",
			`  ✓ B In backend${" ".repeat(40)}effort ▰▰▰▱▱  risk ▰▰▱▱▱`,
			'    "only alarms"',
			"    A  In processor ★",
			"    C  Mine",
		]);
		const own = lines(choiceEntry({ ...noComment, chosen: "C" }, DECISION, true), 40);
		assert.match(own[2]!, /✓ C Mine +your own option/);
		const narrow = lines(choiceEntry(choice({ chosen: "A" }), DECISION, true), 30);
		assert.equal(narrow[2], "  ✓ A In processor ★");
	});

	it("a choice without its decision shows the bare answer", () => {
		assert.deepEqual(lines(choiceEntry(noComment, undefined, true)), ["◆ q1 ✓ B"]);
	});

	it("a verdict is a divider, with the comment beside it or wrapped below", () => {
		assert.match(lines(verdictEntry(verdict(), false))[0]!, /^── ✓ Frame approved → Explore ─+$/);
		assert.match(
			lines(verdictEntry(verdict({ phase: "blueprint" }), false))[0]!,
			/✓ Blueprint approved · the plan is final/,
		);
		const changes = verdict({ verdict: "changes", comment: "tighten the scope" });
		assert.match(lines(verdictEntry(changes, false))[0]!, /^── ↻ Frame: changes requested {2}"tighten the scope" ─+$/);
		assert.deepEqual(lines(verdictEntry(changes, true)), [
			`── ↻ Frame: changes requested ${"─".repeat(50)}`,
			'   "tighten the scope"',
		]);
		assert.equal(lines(verdictEntry(changes, false), 20)[0], "── ↻ Frame: changes…");
	});

	it("fit every width and use the theme", () => {
		for (const expanded of [false, true]) {
			assertFits(
				(w, theme) => new SpanView(theme, choiceEntry(choice(), DECISION, expanded)).render(w),
				[1, 30, 80, 200],
			);
			assertFits(
				(w, theme) => new SpanView(theme, verdictEntry(verdict({ comment: "a comment" }), expanded)).render(w),
				[1, 30, 80, 200],
			);
		}
		const tagged = new SpanView(tagTheme, verdictEntry(verdict(), false)).render(60)[0]!;
		assert.match(tagged, /<success><b>✓ Frame approved<\/b><\/success>/);
		assert.match(tagged, /<borderMuted>── <\/borderMuted>/);
		new SpanView(plainTheme, () => []).invalidate();
	});

	it("the extension renders choices from the current state, and verdicts", async () => {
		const entry = (input: EventInput): BranchEntry => ({ type: "custom", customType: ENTRY_TYPE, data: event(input) });
		const h = harness({
			branch: [
				entry({ type: "begin", feature: "Dedupe", slug: "dedupe", at: 1 }),
				entry({ type: "mode", mode: "architect", at: 2 }),
				entry({ type: "decision", decision: { ...DECISION, chosen: undefined } as unknown as Decision }),
			],
		});
		await h.fire("session_start", { reason: "resume" });
		const render = (data: unknown, expanded = false) =>
			plain(
				(
					h.entryRenderers[ENTRY_TYPE]!({ type: "custom", customType: ENTRY_TYPE, data }, { expanded }, plainTheme) as {
						render(w: number): string[];
					}
				).render(100),
			).map((l) => l.trimEnd());
		assert.match(render(choice())[0]!, /◆ q1 ✓ B In backend {2}"only alarms" · Where do/);
		assert.equal(render(choice(), true).length, 5);
		assert.match(render(choice({ id: "q9" }))[0]!, /^◆ q9 ✓ B {2}"only alarms"$/);
		assert.match(render(verdict())[0]!, /── ✓ Frame approved/);
	});
});

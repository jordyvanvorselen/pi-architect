import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { decisionLines, optionLabels, selectDecision, type DecisionUi } from "../src/decision.ts";
import { ENTRY_TYPE, event, type EventInput } from "../src/state/events.ts";
import { rebuild } from "../src/state/reducer.ts";
import type { Decision, DecisionOption } from "../src/state/types.ts";
import { ownOption, planDecision, prepareDecideArgs, type DecideInput } from "../src/tools/decide.ts";
import { decideCall, decideResult } from "../src/ui/decision/rows.ts";
import { harness, type BranchEntry } from "./harness.ts";
import { FakeUi, KEYS, plainTheme, tagTheme, type } from "./helpers.ts";

const entry = (input: EventInput): BranchEntry => ({ type: "custom", customType: ENTRY_TYPE, data: event(input) });

/** A session in architect mode, at the Decide phase. */
function inDecide(): BranchEntry[] {
	return [
		entry({ type: "begin", feature: "Dedupe", slug: "dedupe", at: 1 }),
		entry({ type: "mode", mode: "architect", at: 2 }),
		entry({ type: "verdict", phase: "frame", verdict: "approved", at: 3 }),
		entry({ type: "verdict", phase: "explore", verdict: "approved", at: 4 }),
	];
}

const INPUT = {
	question: "Where do panel events get deduplicated?",
	context: "Panels resend events during failover.",
	options: [
		{
			title: "In processor",
			summary: "Drop repeats as they stream in.",
			pros: ["one owner"],
			cons: ["state per node"],
			effort: 2,
			risk: 1,
		},
		{ title: "In backend", pros: ["has DB context"], cons: ["later dedup"], effort: 3, risk: 2 },
		{ title: "Redis stream", pros: ["scales out"], cons: ["new infra"], effort: 4, risk: 3 },
	],
	recommended: "A",
	reason: "One owner, no new infra.",
};

async function session(ui?: FakeUi, mode?: "tui" | "rpc", decide?: DecisionUi) {
	const h = harness({
		branch: inDecide(),
		...(ui ? { ui } : {}),
		...(mode ? { mode } : {}),
		...(decide ? { overrides: { decide } } : {}),
	});
	await h.fire("session_start", { reason: "resume" });
	return h;
}

const arch = (h: ReturnType<typeof harness>) => rebuild(h.branch).architecture!;
const types = (h: ReturnType<typeof harness>) => h.entries.map((e) => e.data.type);

describe("architect_decide", () => {
	it("is registered inactive and sequential, and turns on in architect mode", async () => {
		const h = await session(new FakeUi());
		const tool = h.tools.architect_decide!;
		assert.equal(tool.defaultActive, false);
		assert.equal(tool.executionMode, "sequential");
		assert.ok(h.active().includes("architect_decide"));
	});

	it("returns the chosen option and records the decision and the choice", async () => {
		const ui = new FakeUi().keys([KEYS.right, KEYS.enter]);
		const h = await session(ui);
		const result = await h.call("architect_decide", INPUT);
		assert.equal(
			result.content[0]!.text,
			'The user chose B "In backend" for q1 (you recommended A). Raise the next open question, or call architect_advance when every decision is made.',
		);
		assert.deepEqual(types(h), ["decision", "choice"]);
		assert.deepEqual(h.entries[1]!.data.snapshot, {
			question: INPUT.question,
			recommendation: "A",
			options: [
				{ id: "A", title: "In processor", effort: 2, risk: 1 },
				{ id: "B", title: "In backend", effort: 3, risk: 2 },
				{ id: "C", title: "Redis stream", effort: 4, risk: 3 },
			],
		});
		const d = arch(h).decisions[0]!;
		assert.equal(d.chosen, "B");
		assert.equal(d.recommendation, "A");
		assert.equal(d.reason, "One owner, no new infra.");
		assert.deepEqual(
			d.options.map((o) => o.id),
			["A", "B", "C"],
		);
		assert.deepEqual(result.details, {
			id: "q1",
			question: INPUT.question,
			index: 1,
			recommended: "A",
			outcome: "chosen",
			chosen: "B",
			title: "In backend",
		});
		assert.deepEqual(ui.customs[0]!.options, { blocked: { kind: "question", message: INPUT.question } });
		assert.match(ui.customs[0]!.frames[0]!.join("\n"), /◆ Decision 1 .* Dedupe/);
	});

	it("passes the user's comment and the expected total, and names what is still open", async () => {
		const ui = new FakeUi().keys([KEYS.escape], ["c", ...type("only alarms"), KEYS.enter]);
		const h = await session(ui);
		await h.call("architect_decide", { ...INPUT, question: "First?" });
		const result = await h.call("architect_decide", { ...INPUT, total: 3 });
		assert.equal(
			result.content[0]!.text,
			'The user chose A "In processor" for q2 and said: "only alarms". Follow what they said. Still open: q1.',
		);
		assert.equal(result.details?.comment, "only alarms");
		assert.equal(result.details?.total, 3);
		// Two decisions are raised, three expected: the card says the 3 is an estimate.
		assert.match(ui.customs[1]!.frames[0]![0]!, /Decision 2 of about 3 /);
		assert.equal(arch(h).decisions[1]!.comment, "only alarms");
	});

	it("counts only raised decisions as N/M, and shows the agent's estimate as one", async () => {
		const ui = new FakeUi().keys([KEYS.escape], [KEYS.escape], [KEYS.escape], [KEYS.escape]);
		const h = await session(ui);
		await h.call("architect_decide", { ...INPUT, total: 2 });
		await h.call("architect_decide", { ...INPUT, question: "Second?" });
		await h.call("architect_decide", { ...INPUT, id: "q1" });
		await h.call("architect_decide", { ...INPUT, question: "Third?", total: 2 });
		const headers = ui.customs.map((c) => c.frames[0]![0]!.match(/Decision [^─]*/)![0].trim());
		// q1 with an estimate of 2 while only q1 exists; q2 is the latest of 2; q1 again with 2 raised;
		// q3 where the estimate is below the real count.
		assert.deepEqual(headers, ["Decision 1 of about 2", "Decision 2/2", "Decision 1/2", "Decision 3/3"]);
	});

	it("records the user's own option as a new option and chooses it", async () => {
		const ui = new FakeUi().keys(["n", ...type("Dedupe at the panel gateway"), KEYS.enter]);
		const h = await session(ui);
		const result = await h.call("architect_decide", INPUT);
		assert.match(
			result.content[0]!.text,
			/^The user chose their own option for q1: "Dedupe at the panel gateway"\. It is recorded as option D\./,
		);
		assert.deepEqual(types(h), ["decision", "decision", "choice"]);
		const d = arch(h).decisions[0]!;
		assert.equal(d.chosen, "D");
		assert.deepEqual(d.options[3], {
			id: "D",
			title: "Dedupe at the panel gateway",
			pros: [],
			cons: [],
			effort: 3,
			risk: 3,
			byUser: true,
		});
		const snapshot = h.entries[2]!.data.snapshot as { options: { id: string; byUser?: boolean }[] };
		assert.deepEqual(snapshot.options[3], {
			id: "D",
			title: "Dedupe at the panel gateway",
			effort: 3,
			risk: 3,
			byUser: true,
		});
		assert.equal(result.details?.outcome, "own");
	});

	it("returns the user's question so the agent answers and asks again with the same id", async () => {
		const ui = new FakeUi().keys(["?", ...type("Why not Redis?"), KEYS.enter], [KEYS.enter]);
		const h = await session(ui);
		const asked = await h.call("architect_decide", INPUT);
		assert.equal(
			asked.content[0]!.text,
			'The user asked about decision q1 instead of choosing: "Why not Redis?". Answer briefly in chat, then call architect_decide again with id "q1". Revise the options if your answer changes them.',
		);
		assert.equal(asked.terminate, undefined);
		assert.equal(asked.details?.asked, "Why not Redis?");
		assert.equal(arch(h).decisions[0]!.chosen, undefined);
		const again = await h.call("architect_decide", { ...INPUT, id: "q1", recommended: "c" });
		assert.equal(again.details?.chosen, "C");
		assert.equal(arch(h).decisions.length, 1);
	});

	it("re-asks the same open question under its id even without one", async () => {
		const ui = new FakeUi().keys([KEYS.escape], [KEYS.enter]);
		const h = await session(ui);
		await h.call("architect_decide", INPUT);
		const result = await h.call("architect_decide", {
			...INPUT,
			question: " where do panel events get deduplicated? ",
		});
		assert.equal(result.details?.id, "q1");
		assert.equal(arch(h).decisions.length, 1);
	});

	it("a closed card stops the agent and leaves the decision open", async () => {
		const ui = new FakeUi().keys([KEYS.escape]);
		const h = await session(ui);
		const result = await h.call("architect_decide", INPUT);
		assert.equal(result.terminate, true);
		assert.equal(result.details?.outcome, "closed");
		assert.match(result.content[0]!.text, /closed decision q1 without choosing\. It stays open/);
		assert.equal(arch(h).decisions[0]!.chosen, undefined);
	});

	it("an interrupt closes the card", async () => {
		const controller = new AbortController();
		const ui = new FakeUi().keys([() => controller.abort()]);
		const h = await session(ui);
		const result = await h.call("architect_decide", INPUT, controller.signal);
		assert.equal(result.details?.outcome, "closed");
	});

	it("closes at once when the run is already interrupted", async () => {
		const controller = new AbortController();
		controller.abort();
		const h = await session(new FakeUi().keys([]));
		const result = await h.call("architect_decide", INPUT, controller.signal);
		assert.equal(result.details?.outcome, "closed");
	});

	it("treats an answer that arrives after an interrupt as closed", async () => {
		const controller = new AbortController();
		const h = await session(new FakeUi(), "tui", async () => {
			controller.abort();
			return { kind: "choose", option: "A" };
		});
		const result = await h.call("architect_decide", INPUT, controller.signal);
		assert.equal(result.details?.outcome, "closed");
		assert.equal(arch(h).decisions[0]!.chosen, undefined);
	});

	it("headless sessions record the decision, tell the agent to ask in chat and stop", async () => {
		const h = await session();
		const result = await h.call("architect_decide", INPUT);
		assert.equal(result.terminate, true);
		assert.equal(result.details?.outcome, "no-ui");
		assert.match(result.content[0]!.text, /no interactive UI\. Decision q1 is recorded and open/);
		assert.deepEqual(types(h), ["decision"]);
	});

	it("RPC clients get the select dialog", async () => {
		const ui = new FakeUi({ select: ["B  In backend"] });
		const h = await session(ui, "rpc");
		const result = await h.call("architect_decide", INPUT);
		assert.equal(result.details?.chosen, "B");
		assert.match(ui.prompts[0]!.title, /^Where do panel events get deduplicated\?\nPanels resend/);
	});
});

describe("planning a decision", () => {
	const state = (entries: BranchEntry[]) => rebuild(entries);
	const input = (over: Partial<DecideInput> = {}) => ({ ...(INPUT as DecideInput), ...over });

	it("only works in architect mode, in Decide, before the plan is final", () => {
		assert.throws(() => planDecision({ mode: "build" }, input()), /only works in architect mode/);
		const frame = state(inDecide().slice(0, 2));
		assert.throws(() => planDecision(frame, input()), /belongs to the Decide phase\. Now in Frame/);
		const final = state(inDecide());
		final.architecture = { ...final.architecture!, approvedAt: 9 };
		assert.throws(() => planDecision(final, input()), /approved and final/);
	});

	it("rejects an empty question, untitled options, a wrong count and an unknown recommendation", () => {
		const s = state(inDecide());
		assert.throws(() => planDecision(s, input({ question: " " })), /needs a question/);
		assert.throws(
			() => planDecision(s, input({ options: [{ ...INPUT.options[0]!, title: " " }, INPUT.options[1]!] })),
			/needs a title/,
		);
		assert.throws(() => planDecision(s, input({ options: [INPUT.options[0]!] })), /2 to 4 options/);
		assert.throws(
			() => planDecision(s, input({ recommended: "Z" })),
			/recommended "Z" names none of the options\. Give the letter of one: "A" \(In processor\), "B"/,
		);
		assert.throws(() => planDecision(s, input({ id: "q9" })), /Unknown decision q9\. Decisions: none/);
	});

	it("finds the recommendation by letter, title or number, and drops empty text", () => {
		const s = state(inDecide());
		assert.equal(planDecision(s, input({ recommended: "in backend" })).recommendation, "B");
		assert.equal(planDecision(s, input({ recommended: "3" })).recommendation, "C");
		for (const wanted of ["Option B", "b", "B) In backend", "B: has DB context"])
			assert.equal(planDecision(s, input({ recommended: wanted })).recommendation, "B", wanted);
		assert.throws(() => planDecision(s, input({ recommended: "Both" })), /names none of the options/);
		const d = planDecision(
			s,
			input({
				context: " ",
				reason: " ",
				options: [{ ...INPUT.options[0]!, summary: " ", pros: [" ", "x"] }, INPUT.options[1]!],
			}),
		);
		assert.equal(d.context, undefined);
		assert.equal(d.reason, undefined);
		assert.equal(d.options[0]!.summary, undefined);
		assert.deepEqual(d.options[0]!.pros, ["x"]);
		assert.deepEqual(d.options[1]!.pros, ["has DB context"]);
	});

	it("gives a long own option a short title and keeps the full text", () => {
		const decision = planDecision(state(inDecide()), input());
		const text = "Dedupe at the gateway with a small window per panel, and log every drop";
		const own = ownOption(decision, text);
		assert.equal(own.id, "D");
		assert.equal(own.title, "Dedupe at the gateway with a small window per p…");
		assert.equal(own.summary, text);
		const full = {
			...decision,
			options: ["A", "B", "C", "D", "E", "F", "G", "H"].map((id) => ({ ...decision.options[0]!, id })),
		};
		assert.equal(ownOption(full, "x").id, "X9");
	});
});

describe("preparing decide arguments", () => {
	it("folds JSON strings, single strings, text ratings and nulls into the schema shape", () => {
		const prepared = prepareDecideArgs({
			question: "Q",
			options: JSON.stringify([
				{ title: "A", pros: "fast", cons: '["x","y"]', effort: "2", risk: 7.2, summary: null },
				{ title: "B", effort: 0, risk: "high" },
				"junk",
			]),
			recommended: "A",
			reason: "r",
			total: "4",
			id: null,
		});
		assert.deepEqual(prepared, {
			question: "Q",
			options: [
				{ title: "A", pros: ["fast"], cons: ["x", "y"], effort: 2, risk: 5 },
				{ title: "B", effort: 1, risk: "high" },
				"junk",
			],
			recommended: "A",
			reason: "r",
			total: 4,
		});
		assert.deepEqual(prepareDecideArgs('{"question":"Q"}'), { question: "Q" });
		assert.deepEqual(prepareDecideArgs("{bad"), {});
		assert.deepEqual(prepareDecideArgs([1]), {});
		assert.deepEqual(prepareDecideArgs({ options: "not json" }), { options: "not json" });
	});
});

describe("the simple decision dialog", () => {
	const decision: Decision = {
		id: "q1",
		question: "Where?",
		context: "It matters.",
		options: [
			{ id: "A", title: "Here", summary: "s", pros: ["p"], cons: ["c"], effort: 2, risk: 1 },
			{ id: "B", title: "There", pros: [], cons: [], effort: 3, risk: 4 },
		],
		recommendation: "A",
		reason: "simple",
	};
	const ctx = (ui: FakeUi) => ({ ui }) as never;

	it("lists the options with ratings, pros, cons and the recommendation", () => {
		assert.deepEqual(decisionLines(decision), [
			"Where?",
			"It matters.",
			"",
			"A  Here ★ · effort 2/5 · risk 1/5",
			"   s",
			"   + p",
			"   − c",
			"",
			"B  There · effort 3/5 · risk 4/5",
			"",
			"★ Agent recommends A: simple",
		]);
		assert.deepEqual(
			decisionLines({ id: "q1", question: "Where?", options: decision.options, recommendation: "Z" }).slice(0, 2),
			["Where?", ""],
		);
		const { reason: _reason, ...plain } = decision;
		assert.equal(decisionLines(plain).at(-1), "★ Agent recommends A");
		assert.deepEqual(optionLabels(decision), ["A  Here ★", "B  There"]);
	});

	it("shows an option the user wrote as their own, without placeholder ratings", () => {
		const own: DecisionOption = { id: "C", title: "Mine", pros: [], cons: [], effort: 3, risk: 3, byUser: true };
		const lines = decisionLines({ ...decision, options: [...decision.options, own] });
		assert.ok(lines.includes("C  Mine · your own option"));
		assert.ok(!lines.some((l) => l.startsWith("C ") && /effort|risk/.test(l)));
	});

	it("chooses, proposes an own option, asks, or closes", async () => {
		const signal = new AbortController().signal;
		let ui = new FakeUi({ select: ["B  There"] });
		assert.deepEqual(await selectDecision({ decision, signal }, ctx(ui)), { kind: "choose", option: "B" });
		assert.equal(ui.prompts[0]!.signal, signal);
		ui = new FakeUi({ select: ["✎ My own option"], input: [" mine "] });
		assert.deepEqual(await selectDecision({ decision }, ctx(ui)), { kind: "own", text: "mine" });
		ui = new FakeUi({ select: ["? Ask a question first"], input: ["why?"] });
		assert.deepEqual(await selectDecision({ decision }, ctx(ui)), { kind: "ask", question: "why?" });
		assert.equal(ui.prompts[1]!.title, "Your question for the agent");
		assert.equal(await selectDecision({ decision }, ctx(new FakeUi({ select: [undefined] }))), undefined);
		assert.equal(
			await selectDecision({ decision }, ctx(new FakeUi({ select: ["✎ My own option"], input: [" "] }))),
			undefined,
		);
		assert.equal(await selectDecision({ decision }, ctx(new FakeUi({ select: ["nope"] }))), undefined);
	});
});

describe("decide tool rows", () => {
	it("call shows the question and the option count, even while the arguments stream in", () => {
		assert.equal(decideCall(undefined, plainTheme), "◆ architect decide");
		assert.equal(
			decideCall({ question: " Where? ", options: [{}] as never }, plainTheme),
			"◆ architect decide  Where? · 1 option",
		);
		assert.equal(decideCall({ options: [{}, {}] as never }, plainTheme), "◆ architect decide  2 options");
		assert.match(
			decideCall({ question: "Q" }, tagTheme),
			/<toolTitle><b>architect decide<\/b><\/toolTitle> {2}<text>Q<\/text>/,
		);
	});

	it("result shows each outcome", () => {
		const base = { id: "q1", question: "Q", index: 1, recommended: "A" };
		const r = (details: Parameters<typeof decideResult>[0], expanded = false) =>
			decideResult(details, "the text", false, expanded, plainTheme);
		assert.equal(r({ ...base, outcome: "chosen", chosen: "A", title: "Here" }), "✓ A Here ★");
		assert.equal(
			r({ ...base, outcome: "chosen", chosen: "B", title: "There", comment: "ok" }),
			'✓ B There · over ★ A  "ok"',
		);
		assert.equal(
			r({ ...base, recommended: undefined, outcome: "chosen", chosen: "B", title: "There" } as never),
			"✓ B There",
		);
		assert.equal(r({ ...base, outcome: "own", chosen: "D", title: "Mine" }), "✎ your own option D Mine");
		assert.equal(r({ ...base, outcome: "asked", asked: "why?" }), '? you asked "why?"');
		assert.equal(r({ ...base, outcome: "asked", asked: "why?" }, true), '? you asked "why?"\nthe text');
		assert.equal(r({ ...base, outcome: "closed" }), "■ q1 closed without a choice · still open");
		assert.equal(r({ ...base, outcome: "no-ui" }), "■ no interactive UI · q1 asked in chat");
		assert.equal(r(undefined), "✗ the text");
		assert.equal(decideResult(undefined, "", true, false, plainTheme), "◉ waiting for your choice…");
	});

	it("the registered renderers reuse their component", async () => {
		const ui = new FakeUi().keys([KEYS.enter]);
		const h = await session(ui);
		const tool = h.tools.architect_decide!;
		const ctx = { lastComponent: undefined, isError: false };
		const call = tool.renderCall!(INPUT, plainTheme, ctx);
		assert.equal(
			stripTerminalSequences(call.render(80)[0]!).trimEnd(),
			`◆ architect decide  ${INPUT.question} · 3 options`,
		);
		assert.equal(tool.renderCall!(INPUT, plainTheme, { ...ctx, lastComponent: call }), call);
		const result = await h.call("architect_decide", INPUT);
		const row = tool.renderResult!(result, { expanded: false, isPartial: false }, plainTheme, ctx);
		assert.equal(stripTerminalSequences(row.render(80)[0]!).trimEnd(), "✓ A In processor ★");
		assert.equal(
			tool.renderResult!(result, { expanded: false, isPartial: false }, plainTheme, { ...ctx, lastComponent: row }),
			row,
		);
		const text = tool.renderResult!(
			{ content: [{ type: "text", text: "boom" }, { type: "image" }], details: undefined },
			{ expanded: false, isPartial: false },
			plainTheme,
			ctx,
		);
		assert.equal(stripTerminalSequences(text.render(80)[0]!).trimEnd(), "✗ boom");
	});
});

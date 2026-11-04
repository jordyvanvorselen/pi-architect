import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ENTRY_TYPE, event, eventsFrom, parseEvent, type EventInput } from "../src/state/events.ts";
import { INITIAL_STATE, isApproved, isPristine, rebuild, reduce, upsert } from "../src/state/reducer.ts";
import type { Phase } from "../src/state/phases.ts";
import type { ArchitectState, Decision } from "../src/state/types.ts";

const entry = (input: EventInput) => ({ type: "custom", customType: ENTRY_TYPE, data: event(input) });
const replay = (...inputs: EventInput[]) => inputs.map(event).reduce(reduce, INITIAL_STATE);
const arch = (state: ArchitectState) => state.architecture!;

const decision: Decision = {
	id: "d1",
	question: "Where do panel events get deduplicated?",
	options: [
		{ id: "A", title: "In processor", pros: ["one owner"], cons: ["state per node"], effort: 2, risk: 1 },
		{ id: "B", title: "In backend", pros: ["has DB context"], cons: ["later dedup"], effort: 3, risk: 2 },
	],
	recommendation: "A",
};

const approve = (phase: Phase, at = 5): EventInput => ({
	type: "verdict",
	phase,
	verdict: "approved",
	at,
});

describe("mode", () => {
	it("starts in build mode without an architecture", () => {
		assert.deepEqual(rebuild([]), { mode: "build" });
	});

	it("entering architect mode starts an empty architecture at Frame", () => {
		const state = replay({ type: "mode", mode: "architect", at: 1 });
		assert.equal(state.mode, "architect");
		assert.equal(arch(state).phase, "frame");
		assert.equal(arch(state).status, "working");
		assert.equal(arch(state).feature, "");
		assert.equal(arch(state).startedAt, 1);
	});

	it("switching to build keeps the architecture, and switching back resumes at the same phase", () => {
		const state = replay(
			{ type: "begin", feature: "Dedupe panel events", slug: "dedupe-panel-events", at: 1 },
			{ type: "mode", mode: "architect", at: 1 },
			approve("frame"),
			{ type: "mode", mode: "build", at: 6 },
			{ type: "mode", mode: "architect", at: 7 },
		);
		assert.equal(state.mode, "architect");
		assert.equal(arch(state).phase, "explore");
		assert.equal(arch(state).feature, "Dedupe panel events");
		assert.equal(arch(state).startedAt, 1);
	});

	it("remembers the write tools the user had off when entering architect mode, until the next entry", () => {
		const first = replay({ type: "mode", mode: "architect", at: 1, keptOff: ["write"] });
		assert.deepEqual(first.keptOff, ["write"]);
		const back = reduce(first, event({ type: "mode", mode: "build", at: 2 }));
		assert.deepEqual(back.keptOff, ["write"]);
		const again = reduce(back, event({ type: "mode", mode: "architect", at: 3, keptOff: [] }));
		assert.deepEqual(again.keptOff, []);
		// Events from before keptOff existed: nothing was known to be off.
		assert.deepEqual(replay({ type: "mode", mode: "architect", at: 1 }).keptOff, []);
		assert.equal(rebuild([]).keptOff, undefined);
	});
});

describe("begin and reset", () => {
	it("begin replaces an earlier architecture but keeps the mode", () => {
		const state = replay(
			{ type: "mode", mode: "architect", at: 1 },
			{ type: "update", phase: "frame", brief: { goal: "old" } },
			{ type: "begin", feature: "New thing", slug: "new-thing", at: 2 },
		);
		assert.equal(state.mode, "architect");
		assert.equal(arch(state).brief.goal, "");
		assert.equal(arch(state).slug, "new-thing");
	});

	it("reset in build mode discards the architecture", () => {
		const state = replay(
			{ type: "mode", mode: "architect", at: 1 },
			{ type: "mode", mode: "build", at: 2 },
			{ type: "reset", at: 3 },
		);
		assert.deepEqual(state, { mode: "build", keptOff: [] });
	});

	it("reset in architect mode starts over with an empty architecture", () => {
		const state = replay(
			{ type: "begin", feature: "X", slug: "x", at: 1 },
			{ type: "mode", mode: "architect", at: 1 },
			approve("frame"),
			{ type: "reset", at: 9 },
		);
		assert.equal(arch(state).phase, "frame");
		assert.equal(arch(state).feature, "");
		assert.equal(arch(state).startedAt, 9);
	});
});

describe("update", () => {
	const started: EventInput[] = [{ type: "mode", mode: "architect", at: 1 }];

	it("merges the brief field by field and replaces lists", () => {
		const state = replay(
			...started,
			{ type: "update", phase: "frame", brief: { goal: "Fewer duplicate alarms", constraints: ["no new infra"] } },
			{
				type: "update",
				phase: "frame",
				brief: { constraints: ["no new infra", "keep the API"], doneWhen: ["tests pass"] },
			},
		);
		assert.deepEqual(arch(state).brief, {
			goal: "Fewer duplicate alarms",
			constraints: ["no new infra", "keep the API"],
			outOfScope: [],
			doneWhen: ["tests pass"],
		});
	});

	it("names the feature", () => {
		const state = replay(...started, { type: "update", phase: "frame", feature: { name: "Dedupe", slug: "dedupe" } });
		assert.equal(arch(state).feature, "Dedupe");
		assert.equal(arch(state).slug, "dedupe");
	});

	it("upserts modules by path, findings and risks by id, keeping their order", () => {
		const state = replay(
			...started,
			{
				type: "update",
				phase: "explore",
				modules: [
					{ path: "src/ingest", role: "touched", files: [] },
					{ path: "src/api", role: "context", files: [] },
				],
				findings: [{ id: "f1", text: "events arrive twice" }],
				risks: [{ id: "r1", text: "ordering", severity: "medium" }],
			},
			{
				type: "update",
				phase: "explore",
				modules: [{ path: "src/ingest", role: "touched", files: ["src/ingest/processor.ts"], note: "dedupe here" }],
				risks: [{ id: "r1", text: "ordering across nodes", severity: "high", mitigation: "sticky routing" }],
			},
		);
		assert.deepEqual(
			arch(state).modules.map((m) => [m.path, m.files.length]),
			[
				["src/ingest", 1],
				["src/api", 0],
			],
		);
		assert.equal(arch(state).risks.length, 1);
		assert.equal(arch(state).risks[0]!.severity, "high");
		assert.equal(arch(state).findings[0]!.text, "events arrive twice");
	});

	it("removes items by id or module path from every collection", () => {
		const state = replay(
			...started,
			{
				type: "update",
				phase: "explore",
				modules: [{ path: "src/api", role: "context", files: [] }],
				findings: [
					{ id: "f1", text: "a" },
					{ id: "f2", text: "b" },
				],
				risks: [{ id: "r1", text: "x", severity: "low" }],
			},
			{ type: "decision", decision },
			{ type: "diagram", diagram: { id: "g1", phase: "design", title: "flow", body: "a ──▶ b" } },
			{ type: "slices", slices: [{ id: "s1", title: "one", dependsOn: [], files: [], steps: [], verify: [] }] },
			{ type: "update", phase: "explore", remove: ["src/api", "f1", "r1", "d1", "g1", "s1"] },
		);
		const a = arch(state);
		assert.deepEqual(
			a.findings.map((f) => f.id),
			["f2"],
		);
		assert.deepEqual(
			[a.modules, a.risks, a.decisions, a.diagrams, a.slices].map((l) => l.length),
			[0, 0, 0, 0, 0],
		);
	});
});

describe("decisions, diagrams and slices", () => {
	const started: EventInput[] = [
		{ type: "mode", mode: "architect", at: 1 },
		{ type: "decision", decision },
	];

	it("records the user's choice and comment", () => {
		const state = replay(...started, { type: "choice", id: "d1", chosen: "B", comment: "only for alarms" });
		assert.equal(arch(state).decisions[0]!.chosen, "B");
		assert.equal(arch(state).decisions[0]!.comment, "only for alarms");
	});

	it("a later choice without a comment drops the old comment", () => {
		const state = replay(
			...started,
			{ type: "choice", id: "d1", chosen: "B", comment: "only for alarms" },
			{ type: "choice", id: "d1", chosen: "A" },
		);
		assert.equal(arch(state).decisions[0]!.chosen, "A");
		assert.equal(arch(state).decisions[0]!.comment, undefined);
	});

	it("ignores a choice for an unknown decision or option", () => {
		const before = replay(...started);
		const after = [
			event({ type: "choice", id: "d9", chosen: "A" }),
			event({ type: "choice", id: "d1", chosen: "Z" }),
		].reduce(reduce, before);
		assert.equal(after, before);
	});

	it("upserts diagrams by id", () => {
		const state = replay(
			...started,
			{ type: "diagram", diagram: { id: "g1", phase: "design", title: "v1", body: "a" } },
			{ type: "diagram", diagram: { id: "g1", phase: "design", title: "v2", body: "a ──▶ b" } },
			{ type: "diagram", diagram: { id: "g2", phase: "design", title: "calls", body: "x", caption: "c" } },
		);
		assert.deepEqual(
			arch(state).diagrams.map((d) => d.title),
			["v2", "calls"],
		);
	});

	it("upserts slices by id, or replaces them all", () => {
		const slice = (id: string, title: string) => ({ id, title, dependsOn: [], files: [], steps: [], verify: [] });
		const upserted = replay(
			...started,
			{ type: "slices", slices: [slice("s1", "a"), slice("s2", "b")] },
			{ type: "slices", slices: [slice("s2", "B")] },
		);
		assert.deepEqual(
			arch(upserted).slices.map((s) => s.title),
			["a", "B"],
		);
		const replaced = [event({ type: "slices", slices: [slice("s3", "c")], replace: true })].reduce(reduce, upserted);
		assert.deepEqual(
			arch(replaced).slices.map((s) => s.id),
			["s3"],
		);
	});
});

describe("the gate", () => {
	const started: EventInput[] = [{ type: "mode", mode: "architect", at: 1 }];

	it("submit puts the phase in review with the summary", () => {
		const state = replay(...started, { type: "submit", phase: "frame", summary: "Check the scope", at: 2 });
		assert.equal(arch(state).status, "review");
		assert.equal(arch(state).submitted, "Check the scope");
	});

	it("withdraw puts the phase back to working", () => {
		const state = replay(
			...started,
			{ type: "submit", phase: "frame", summary: "s", at: 2 },
			{ type: "withdraw", phase: "frame", at: 3 },
		);
		assert.equal(arch(state).status, "working");
		assert.equal(arch(state).submitted, undefined);
	});

	it("requested changes keep the phase and record the comment", () => {
		const state = replay(
			...started,
			{ type: "submit", phase: "frame", at: 2 },
			{ type: "verdict", phase: "frame", verdict: "changes", comment: "tighten the scope", at: 3 },
		);
		assert.equal(arch(state).phase, "frame");
		assert.equal(arch(state).status, "working");
		assert.deepEqual(arch(state).reviews, [
			{ phase: "frame", verdict: "changes", comment: "tighten the scope", at: 3 },
		]);
	});

	it("approval moves to the next phase; phases cannot be skipped", () => {
		const state = replay(...started, approve("frame"), approve("decide"), approve("slice"));
		assert.equal(arch(state).phase, "explore");
		assert.equal(arch(state).reviews.length, 1);
	});

	it("approving the Blueprint makes the architecture final", () => {
		const state = replay(
			...started,
			approve("frame"),
			approve("explore"),
			approve("decide"),
			approve("design"),
			approve("slice"),
			approve("blueprint", 42),
		);
		assert.equal(arch(state).phase, "blueprint");
		assert.equal(arch(state).approvedAt, 42);
		assert.equal(isApproved(arch(state)), true);
		const after = [event({ type: "update", phase: "blueprint", brief: { goal: "changed" } })].reduce(reduce, state);
		assert.equal(after, state);
	});

	it("ignores submit, withdraw and verdict for another phase", () => {
		const before = replay(...started);
		const after = [
			event({ type: "submit", phase: "explore", at: 2 }),
			event({ type: "withdraw", phase: "explore", at: 2 }),
			event({ type: "verdict", phase: "explore", verdict: "approved", at: 2 }),
		].reduce(reduce, before);
		assert.equal(after, before);
	});
});

describe("reducer purity", () => {
	it("never changes its input state", () => {
		const before = replay({ type: "mode", mode: "architect", at: 1 }, { type: "decision", decision });
		const snapshot = structuredClone(before);
		reduce(before, event({ type: "update", phase: "frame", brief: { goal: "g", constraints: ["c"] } }));
		reduce(before, event({ type: "choice", id: "d1", chosen: "A" }));
		reduce(before, event({ type: "verdict", phase: "frame", verdict: "approved", at: 2 }));
		reduce(before, event({ type: "mode", mode: "build", at: 2 }));
		assert.deepEqual(before, snapshot);
	});

	it("ignores content events before any architecture exists", () => {
		const state = replay(
			{ type: "update", phase: "frame", brief: { goal: "g" } },
			{ type: "submit", phase: "frame", at: 1 },
		);
		assert.deepEqual(state, { mode: "build" });
	});

	it("replaying the same events always gives the same state", () => {
		const inputs: EventInput[] = [
			{ type: "mode", mode: "architect", at: 1 },
			{ type: "update", phase: "frame", brief: { goal: "g", doneWhen: ["d"] }, feature: { name: "F", slug: "f" } },
			approve("frame"),
		];
		assert.deepEqual(replay(...inputs), replay(...inputs));
	});
});

describe("rebuilding from a branch", () => {
	it("reads only architect entries of this version", () => {
		const branch = [
			{ type: "message", message: {} },
			{ type: "custom", customType: "other", data: event({ type: "mode", mode: "architect", at: 1 }) },
			entry({ type: "mode", mode: "architect", at: 1 }),
			{ type: "custom", customType: ENTRY_TYPE, data: { v: 99, type: "mode", mode: "build", at: 2 } },
			{ type: "custom", customType: ENTRY_TYPE, data: { v: 1, type: "nonsense" } },
			{ type: "custom", customType: ENTRY_TYPE },
		];
		assert.equal(eventsFrom(branch).length, 1);
		assert.equal(rebuild(branch).mode, "architect");
	});

	it("a fork that leaves out later entries is a what-if branch", () => {
		const shared = [entry({ type: "mode", mode: "architect", at: 1 }), entry({ type: "decision", decision })];
		const pickA = rebuild([...shared, entry({ type: "choice", id: "d1", chosen: "A" })]);
		const pickB = rebuild([...shared, entry({ type: "choice", id: "d1", chosen: "B" })]);
		assert.equal(arch(pickA).decisions[0]!.chosen, "A");
		assert.equal(arch(pickB).decisions[0]!.chosen, "B");
	});

	it("parseEvent rejects non-objects", () => {
		assert.equal(parseEvent(null), undefined);
		assert.equal(parseEvent("mode"), undefined);
		assert.equal(parseEvent({ v: 1 }), undefined);
	});
});

describe("helpers", () => {
	it("upsert replaces in place and appends new items", () => {
		assert.deepEqual(
			upsert(
				[
					{ k: "a", n: 1 },
					{ k: "b", n: 1 },
				],
				[
					{ k: "b", n: 2 },
					{ k: "c", n: 1 },
				],
				(i) => i.k,
			),
			[
				{ k: "a", n: 1 },
				{ k: "b", n: 2 },
				{ k: "c", n: 1 },
			],
		);
	});

	it("a fresh or merely named architecture is pristine; any content is not", () => {
		assert.equal(isPristine(undefined), true);
		assert.equal(isPristine(arch(replay({ type: "begin", feature: "F", slug: "f", at: 1 }))), true);
		const content: EventInput[] = [
			{ type: "update", phase: "frame", brief: { goal: "g" } },
			{ type: "update", phase: "frame", brief: { outOfScope: ["x"] } },
			{ type: "update", phase: "frame", risks: [{ id: "r1", text: "r", severity: "low" }] },
			approve("frame"),
		];
		for (const input of content)
			assert.equal(isPristine(arch(replay({ type: "mode", mode: "architect", at: 1 }, input))), false);
	});
});

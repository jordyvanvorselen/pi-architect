import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGroups, buildOrder, orderLine } from "../src/plan/order.ts";
import { event } from "../src/state/events.ts";
import { newArchitecture, reduce } from "../src/state/reducer.ts";
import type { Architecture, Slice } from "../src/state/types.ts";
import { planSlices, prepareSliceArgs, sliceErrors, type SliceInput } from "../src/tools/slice.ts";
import { sliceCall, sliceResult } from "../src/ui/slice.ts";
import { plainTheme, tagTheme } from "./helpers.ts";

type In = SliceInput["slices"][number];

const good = (id: string, depends_on: string[] = [], extra: Partial<In> = {}): In => ({
	id,
	title: `Slice ${id}`,
	goal: `Slice ${id} is built.`,
	depends_on,
	files: [`src/${id}.ts`],
	steps: [`Add the ${id} function to src/${id}.ts`],
	verify: [`npm test -- tests/${id}.test.ts`],
	...extra,
});

const slice = (id: string, dependsOn: string[] = []): Slice => ({
	id,
	title: id,
	goal: "g",
	dependsOn,
	files: ["f"],
	steps: ["Add a thing to f"],
	verify: ["npm test"],
});

function at(partial: Partial<Architecture> = {}): Architecture {
	return { ...newArchitecture(1, "Dedupe", "dedupe"), phase: "slice", ...partial };
}

/** The error message, for assertions. */
function error(arch: Architecture, slices: In[]): string {
	try {
		planSlices(arch, { slices });
	} catch (e) {
		return (e as Error).message;
	}
	assert.fail("planSlices accepted the slices");
}

describe("prepareSliceArgs", () => {
	it("accepts camelCase keys, JSON strings, single strings and a single slice", () => {
		assert.deepEqual(
			prepareSliceArgs({
				slices: '{"id":"s1","dependsOn":"s0","files":"a.ts","steps":["x"],"verify":"npm test","goal":null}',
			}),
			{ slices: [{ id: "s1", depends_on: ["s0"], files: ["a.ts"], steps: ["x"], verify: ["npm test"] }] },
		);
		assert.deepEqual(prepareSliceArgs([{ id: "s1", after: ["s0"] }]), { slices: [{ id: "s1", depends_on: ["s0"] }] });
		assert.deepEqual(prepareSliceArgs('{"slices":[{"id":"s2","depends":[]}]}'), {
			slices: [{ id: "s2", depends_on: [] }],
		});
	});

	it("keeps broken JSON as text and turns nonsense into an empty list", () => {
		assert.deepEqual(prepareSliceArgs({ slices: ["[broken"] }), { slices: ["[broken"] });
		assert.deepEqual(prepareSliceArgs({ slices: [{ steps: "[nope" }] }), { slices: [{ steps: ["[nope"] }] });
		assert.deepEqual(prepareSliceArgs(undefined), { slices: [] });
		assert.deepEqual(prepareSliceArgs({ slices: 3 }), { slices: [] });
		assert.deepEqual(prepareSliceArgs({}), { slices: [] });
	});
});

describe("sliceErrors", () => {
	it("accepts a valid graph", () => {
		assert.deepEqual(sliceErrors([slice("s1"), slice("s2", ["s1"])]), []);
	});

	it("needs at least one slice", () => {
		assert.deepEqual(sliceErrors([]), ["Send at least one slice."]);
	});

	it("reports missing, malformed and duplicate ids", () => {
		assert.deepEqual(sliceErrors([{ ...slice(""), title: "t" }, slice("has space"), slice("s1"), slice("s1")]), [
			"slice 1: needs an id.",
			'has space: the id must be short, without spaces, e.g. "s1".',
			"s1: the id is used twice. Ids must be unique.",
		]);
	});

	it("reports unknown dependencies, self-dependencies and cycles", () => {
		assert.deepEqual(sliceErrors([slice("s1", ["s9"]), slice("s2", ["s2"])]), [
			"s1 depends on unknown slice s9.",
			"s2 depends on itself.",
		]);
		assert.deepEqual(sliceErrors([slice("a", ["c"]), slice("b", ["a"]), slice("c", ["b"])]), ["cycle a → c → b → a."]);
	});

	it("needs a title, goal, files, steps and verify commands", () => {
		const empty: Slice = { id: "s1", title: "", goal: "", dependsOn: [], files: [], steps: [], verify: [] };
		assert.deepEqual(sliceErrors([empty]), [
			"s1: needs a title.",
			"s1: needs a goal, one sentence on what is true once it is built.",
			"s1: needs at least one file it creates or changes.",
			"s1: needs at least one step.",
			"s1: needs at least one verify command.",
		]);
		assert.deepEqual(sliceErrors([{ ...slice("s1"), title: "x".repeat(81), goal: "g" }]), [
			"s1: the title is longer than 80 characters.",
		]);
	});

	it("rejects steps a builder cannot act on", () => {
		const steps = [
			"TBD",
			"implement it",
			"do stuff",
			"Wire up the handler etc.",
			"Add the cache layer TODO",
			"Add the store ...",
		];
		const errors = sliceErrors([{ ...slice("s1"), goal: "g", steps }]);
		assert.deepEqual(errors, [
			's1: step 1 "TBD" is a placeholder. Name the file, function or type and the change.',
			's1: step 2 "implement it" is a placeholder. Name the file, function or type and the change.',
			's1: step 3 "do stuff" is too short to act on. Name the file, function or type and the change.',
			's1: step 4 "Wire up the handler etc." is a placeholder. Name the file, function or type and the change.',
			's1: step 5 "Add the cache layer TODO" is a placeholder. Name the file, function or type and the change.',
			's1: step 6 "Add the store ..." is a placeholder. Name the file, function or type and the change.',
		]);
		const long = sliceErrors([{ ...slice("s1"), goal: "g", steps: [`TBD ${"x".repeat(60)}`] }]);
		assert.match(long[0]!, /step 1 "TBD x{35}…" is a placeholder/);
	});

	it("rejects verify entries that are not commands", () => {
		const verify = ["tests pass", "Manual check", "it works.", "npm test"];
		assert.deepEqual(sliceErrors([{ ...slice("s1"), goal: "g", verify }]), [
			's1: verify "tests pass" is not a command. Give the exact command, e.g. "npm test".',
			's1: verify "Manual check" is not a command. Give the exact command, e.g. "npm test".',
			's1: verify "it works." is not a command. Give the exact command, e.g. "npm test".',
		]);
	});
});

describe("build order", () => {
	it("groups slices by dependency depth, keeping the input order within a group", () => {
		const slices = [slice("d", ["b", "c"]), slice("b", ["a"]), slice("a"), slice("c", ["a"]), slice("e")];
		assert.deepEqual(
			buildGroups(slices).map((g) => g.map((s) => s.id)),
			[["a", "e"], ["b", "c"], ["d"]],
		);
		const order = buildOrder(slices);
		assert.deepEqual(
			order.map((o) => `${o.number}:${o.slice.id}@${o.step}`),
			["1:a@1", "2:e@1", "3:b@2", "4:c@2", "5:d@3"],
		);
		assert.equal(orderLine(order), "1, 2 → 3, 4 → 5");
	});

	it("ignores unknown and self dependencies, and puts a cycle last instead of losing it", () => {
		assert.deepEqual(
			buildGroups([slice("a", ["a", "zz"]), slice("b", ["c"]), slice("c", ["b"])]).map((g) => g.map((s) => s.id)),
			[["a"], ["b", "c"]],
		);
		assert.deepEqual(buildGroups([]), []);
		assert.equal(orderLine([]), "");
	});
});

describe("planSlices", () => {
	it("replaces the slice list and answers with the build order", () => {
		const plan = planSlices(at(), {
			slices: [good("s1"), good("s2", ["s1"]), good("s3", ["s1"]), good("s4", ["s2", "s3"])],
		});
		assert.deepEqual(plan.event.replace, true);
		assert.equal(
			plan.text,
			"Saved 4 slices. Build order: 1. s1 → 2. s2 + s3 → 3. s4. Slices joined by + can be built in parallel. " +
				"Slice is ready: call architect_advance when the user should review it.",
		);
		assert.deepEqual(plan.details.groups, [["s1"], ["s2", "s3"], ["s4"]]);
		assert.deepEqual(plan.details.added, ["s1", "s2", "s3", "s4"]);
		assert.equal(plan.details.titles.s4, "Slice s4");
		assert.deepEqual(plan.details.missing, []);
	});

	it("trims input, drops empty and duplicate list items, and leaves out an empty goal only when invalid", () => {
		const plan = planSlices(at(), {
			slices: [
				good("s1", [], {
					id: " s1 ",
					title: "  Store   the key ",
					goal: " g ",
					files: ["a.ts", "a.ts", " "],
					steps: [" Add the key to a.ts ", ""],
				}),
			],
		});
		assert.deepEqual(plan.event.slices[0], {
			id: "s1",
			title: "Store the key",
			goal: "g",
			dependsOn: [],
			files: ["a.ts"],
			steps: ["Add the key to a.ts"],
			verify: ["npm test -- tests/s1.test.ts"],
		});
		assert.equal(
			plan.text,
			"Saved 1 slice. Build order: 1. s1. Slice is ready: call architect_advance when the user should review it.",
		);
	});

	it("says what changed compared with the earlier list", () => {
		const first = planSlices(at(), { slices: [good("s1"), good("s2")] });
		const arch = reduce({ mode: "architect", architecture: at() }, event(first.event)).architecture!;
		const second = planSlices(arch, {
			slices: [good("s1"), good("s3"), { ...good("s2"), title: "Renamed" }].slice(0, 2),
		});
		assert.deepEqual([second.details.added, second.details.changed, second.details.removed], [["s3"], [], ["s2"]]);
		const third = planSlices(arch, { slices: [{ ...good("s2"), title: "Renamed" }] });
		assert.deepEqual([third.details.added, third.details.changed, third.details.removed], [[], ["s2"], ["s1"]]);
	});

	it("fails with every problem at once and saves nothing", () => {
		const message = error(at(), [good("s1", ["s2"]), good("s2", ["s1"], { verify: [] })]);
		assert.equal(
			message,
			[
				"The slices were not saved. Fix these and send the full list again:",
				"- s2: needs at least one verify command.",
				"- cycle s1 → s2 → s1.",
			].join("\n"),
		);
		assert.equal(
			error(at(), []),
			"The slices were not saved. Fix this and send the full list again:\n- Send at least one slice.",
		);
		assert.match(error(at(), [{ id: "s1" } as In]), /s1: needs a title/);
	});

	it("works in Slice and Blueprint only, and never on an approved plan", () => {
		assert.throws(
			() => planSlices(at({ phase: "design" }), { slices: [good("s1")] }),
			/Slices belong to the Slice phase\. You are in Design/,
		);
		assert.ok(planSlices(at({ phase: "blueprint" }), { slices: [good("s1")] }));
		assert.throws(() => planSlices(at({ approvedAt: 5 }), { slices: [good("s1")] }), /approved and final/);
	});

	it("reports what the phase still needs", () => {
		const plan = planSlices(at(), { slices: [good("s1")] }, (tool) => tool !== "architect_slice");
		assert.deepEqual(plan.details.missing, []);
	});
});

describe("slice rendering", () => {
	const details = planSlices(at(), { slices: [good("s1"), good("s2", ["s1"]), good("s3", ["s1"])] }).details;

	it("shows the number of slices in the call", () => {
		assert.equal(sliceCall(undefined, plainTheme), "◆ architect slice");
		assert.equal(sliceCall({ slices: [good("s1"), good("s2")] }, plainTheme), "◆ architect slice  2 slices");
		assert.equal(
			sliceCall({ slices: [good("s1")] }, tagTheme),
			"<accent>◆</accent> <toolTitle><b>architect slice</b></toolTitle>  <muted>1 slice</muted>",
		);
	});

	it("shows the build order collapsed, and titles and changes expanded", () => {
		assert.equal(
			sliceResult(details, "", false, false, plainTheme),
			["✓ 3 slices in 2 steps · Slice ready for review", "   1  s1", "   2  s2 ∥ s3"].join("\n"),
		);
		assert.equal(
			sliceResult({ ...details, changed: ["s1"], removed: ["s9"] }, "", true, false, plainTheme),
			[
				"✓ 3 slices in 2 steps · Slice ready for review",
				"   1  s1 Slice s1",
				"   2  s2 Slice s2 ∥ s3 Slice s3",
				"  + s1, s2, s3  ~ s1  − s9",
			].join("\n"),
		);
		assert.equal(
			sliceResult({ ...details, added: [], titles: {}, groups: [["s1"]] }, "", true, false, plainTheme),
			["✓ 1 slice in 1 step · Slice ready for review", "   1  s1 "].join("\n"),
		);
		assert.equal(
			sliceResult({ ...details, missing: ["x"], phase: "blueprint" }, "", false, false, plainTheme).split("\n")[0],
			"✓ 3 slices in 2 steps · Blueprint needs x",
		);
	});

	it("shows errors and plain text", () => {
		assert.equal(sliceResult(undefined, "boom", false, true, tagTheme), "<error>✗ boom</error>");
		assert.equal(sliceResult(undefined, "text", false, false, tagTheme), "<muted>text</muted>");
	});
});

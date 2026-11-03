import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { event } from "../src/state/events.ts";
import { newArchitecture, reduce } from "../src/state/reducer.ts";
import type { Architecture } from "../src/state/types.ts";
import { planUpdate, prepareUpdateArgs, type UpdateInput } from "../src/tools/update.ts";

function at(partial: Partial<Architecture> = {}): Architecture {
	return { ...newArchitecture(1, "Dedupe", "dedupe"), ...partial };
}

/** Apply the planned event, like the extension does. */
function apply(arch: Architecture, input: UpdateInput): Architecture {
	const plan = planUpdate(arch, input);
	return reduce({ mode: "architect", architecture: arch }, event(plan.event)).architecture!;
}

describe("prepareUpdateArgs", () => {
	it("accepts camelCase keys, JSON strings and single strings for lists", () => {
		assert.deepEqual(
			prepareUpdateArgs({
				brief: '{"goal":"g","outOfScope":"alarms","doneWhen":["a"],"constraints":null}',
				findings: "one finding",
				risks: "a risk",
				modules: { path: "src", role: "touched", files: "src/a.ts" },
				remove: null,
			}),
			{
				brief: { goal: "g", out_of_scope: ["alarms"], done_when: ["a"] },
				findings: ["one finding"],
				risks: [{ text: "a risk" }],
				modules: [{ path: "src", role: "touched", files: ["src/a.ts"] }],
			},
		);
	});

	it("wraps a single risk object and keeps broken JSON as text", () => {
		assert.deepEqual(prepareUpdateArgs({ risks: { text: "x" }, findings: "[broken" }), {
			risks: [{ text: "x" }],
			findings: ["[broken"],
		});
	});

	it("turns anything but an object into an empty update", () => {
		assert.deepEqual(prepareUpdateArgs("nonsense"), {});
		assert.deepEqual(prepareUpdateArgs([1]), {});
		assert.deepEqual(prepareUpdateArgs(undefined), {});
	});
});

describe("planUpdate", () => {
	it("trims the brief and drops empty list items", () => {
		const plan = planUpdate(at(), {
			brief: { goal: "  g  ", constraints: [" a ", ""], out_of_scope: ["x"], done_when: ["d1", "d2"] },
		});
		assert.deepEqual(plan.event.brief, { goal: "g", constraints: ["a"], outOfScope: ["x"], doneWhen: ["d1", "d2"] });
		assert.deepEqual(plan.details.changes, ["brief: goal, 1 constraint, 1 out of scope, 2 done-when"]);
		assert.match(plan.text, /Frame is ready: call architect_advance/);
	});

	it("names the feature with a slug, but not once Frame is approved", () => {
		const plan = planUpdate(at({ feature: "" }), { feature: " Dedupe panel events " });
		assert.deepEqual(plan.event.feature, { name: "Dedupe panel events", slug: "dedupe-panel-events" });
		assert.throws(() => planUpdate(at({ phase: "explore" }), { feature: "Other" }), /Frame is approved/);
		assert.ok(planUpdate(at({ phase: "explore", feature: "" }), { feature: "Late name" }));
	});

	it("says what the phase still needs", () => {
		const plan = planUpdate(at({ feature: "" }), { brief: { goal: "g" } });
		assert.equal(plan.text, "Updated brief: goal. Frame still needs a feature name, at least one done-when.");
		assert.deepEqual(plan.details.missing, ["a feature name", "at least one done-when"]);
	});

	it("keeps the brief fixed after Frame", () => {
		assert.throws(() => planUpdate(at({ phase: "decide" }), { brief: { goal: "new" } }), /brief is fixed/);
	});

	it("keeps modules and findings for Explore and later", () => {
		assert.throws(() => planUpdate(at(), { modules: [{ path: "src", role: "touched" }] }), /Modules belong to Explore/);
		assert.throws(() => planUpdate(at(), { findings: ["x"] }), /Findings belong to Explore/);
	});

	it("adds modules and merges an update into the existing module", () => {
		let arch = apply(at({ phase: "explore" }), {
			modules: [{ path: " src/ingest ", role: "touched", files: ["a.ts"], note: "here" }],
		});
		const plan = planUpdate(arch, {
			modules: [
				{ path: "src/ingest", role: "touched" },
				{ path: "src/api", role: "context" },
			],
		});
		assert.deepEqual(plan.details.changes, ["2 modules (1 new)"]);
		arch = apply(arch, { modules: [{ path: "src/ingest", role: "new" }] });
		assert.deepEqual(arch.modules[0], { path: "src/ingest", role: "new", files: ["a.ts"], note: "here" });
		assert.throws(() => planUpdate(arch, { modules: [{ path: " ", role: "new" }] }), /needs a path/);
	});

	it("numbers findings and risks after the existing ones", () => {
		const arch = at({
			phase: "explore",
			findings: [{ id: "f2", text: "old" }],
			risks: [{ id: "r1", text: "old", severity: "low" }],
		});
		const plan = planUpdate(arch, { findings: ["a", "b"], risks: [{ text: "new" }] });
		assert.deepEqual(
			plan.event.findings!.map((f) => f.id),
			["f3", "f4"],
		);
		assert.deepEqual(plan.event.risks, [{ id: "r2", text: "new", severity: "medium" }]);
		assert.equal(
			plan.text,
			"Updated +2 findings (f3, f4), +1 risk (r2). Explore still needs at least one touched or new module.",
		);
	});

	it("changes a risk by id, keeping fields it does not give", () => {
		const arch = at({ risks: [{ id: "r1", text: "old", severity: "high", mitigation: "m" }] });
		const plan = planUpdate(arch, { risks: [{ id: "r1", text: "ordering" }] });
		assert.deepEqual(plan.event.risks, [{ id: "r1", text: "ordering", severity: "high", mitigation: "m" }]);
		assert.deepEqual(plan.details.changes, ["changed r1"]);
		assert.throws(() => planUpdate(arch, { risks: [{ id: "r9", text: "x" }] }), /Unknown risk r9\. Risks: r1\./);
		assert.throws(() => planUpdate(at(), { risks: [{ id: "r9", text: "x" }] }), /Risks: none/);
		assert.throws(() => planUpdate(arch, { risks: [{ text: "  " }] }), /needs a text/);
	});

	it("removes known ids and module paths, and refuses unknown ones", () => {
		const arch = at({
			phase: "explore",
			modules: [{ path: "src", role: "touched", files: [] }],
			findings: [{ id: "f1", text: "x" }],
		});
		const plan = planUpdate(arch, { remove: ["src", "f1"] });
		assert.deepEqual(plan.details.changes, ["removed src, f1"]);
		assert.deepEqual(plan.details.missing, ["at least one touched or new module"]);
		assert.throws(() => planUpdate(arch, { remove: ["f9"] }), /Nothing to remove with id f9/);
	});

	it("refuses an empty update and any change to an approved plan", () => {
		assert.throws(() => planUpdate(at(), {}), /Nothing to update/);
		assert.throws(() => planUpdate(at(), { brief: {}, findings: [" "] }), /Nothing to update/);
		assert.throws(() => planUpdate(at({ approvedAt: 1 }), { risks: [{ text: "x" }] }), /approved and final/);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { counts, missing, nextId, phaseState, sliceProblems, slugify } from "../src/state/queries.ts";
import { newArchitecture } from "../src/state/reducer.ts";
import type { Architecture, Slice } from "../src/state/types.ts";

const slice = (id: string, dependsOn: string[] = [], verify = ["npm test"]): Slice => ({
	id,
	title: id,
	dependsOn,
	files: [],
	steps: [],
	verify,
});

function at(partial: Partial<Architecture>): Architecture {
	return { ...newArchitecture(1, "Feature", "feature"), ...partial };
}

describe("phaseState", () => {
	it("marks earlier phases approved, the current one by its status and later ones pending", () => {
		const arch = at({ phase: "decide", status: "review" });
		assert.equal(phaseState(arch, "frame"), "approved");
		assert.equal(phaseState(arch, "decide"), "review");
		assert.equal(phaseState(arch, "design"), "pending");
		assert.equal(phaseState(at({ phase: "decide" }), "decide"), "working");
	});

	it("marks every phase approved once the Blueprint is approved", () => {
		assert.equal(phaseState(at({ phase: "blueprint", approvedAt: 5 }), "blueprint"), "approved");
	});
});

describe("ids and names", () => {
	it("nextId continues after the highest number with the prefix", () => {
		assert.equal(nextId([], "f"), "f1");
		assert.equal(nextId(["f1", "f3", "r7", "fx"], "f"), "f4");
	});

	it("slugify makes file-name friendly names", () => {
		assert.equal(slugify("Dedupe panel events!"), "dedupe-panel-events");
		assert.equal(slugify("  Café   déjà vu "), "cafe-deja-vu");
		assert.equal(slugify("???"), "feature");
		assert.ok(slugify("a ".repeat(80)).length <= 60);
		assert.doesNotMatch(slugify("word ".repeat(30)), /-$/);
	});
});

describe("counts", () => {
	it("counts open and decided decisions and risks", () => {
		const option = { id: "A", title: "a", pros: [], cons: [], effort: 1 as const, risk: 1 as const };
		const arch = at({
			decisions: [
				{ id: "d1", question: "q", options: [option] },
				{ id: "d2", question: "q", options: [option], chosen: "A" },
			],
			risks: [
				{ id: "r1", text: "x", severity: "high" },
				{ id: "r2", text: "y", severity: "low" },
			],
		});
		assert.deepEqual(counts(arch), { open: 1, decided: 1, risks: 2, highRisks: 1 });
	});
});

describe("sliceProblems", () => {
	it("is empty for a valid graph", () => {
		assert.deepEqual(sliceProblems([slice("s1"), slice("s2", ["s1"]), slice("s3", ["s1", "s2"])]), []);
	});

	it("reports unknown and self dependencies", () => {
		assert.deepEqual(sliceProblems([slice("s1", ["s1", "s9"])]), [
			"s1 depends on itself",
			"s1 depends on unknown slice s9",
		]);
	});

	it("reports a cycle with its path", () => {
		assert.deepEqual(sliceProblems([slice("s1", ["s3"]), slice("s2", ["s1"]), slice("s3", ["s2"])]), [
			"cycle s1 → s3 → s2 → s1",
		]);
	});
});

describe("missing", () => {
	it("Frame needs a feature name, a goal and a done-when", () => {
		assert.deepEqual(missing(at({ feature: "" })), ["a feature name", "the goal", "at least one done-when"]);
		assert.deepEqual(missing(at({ brief: { goal: "g", constraints: [], outOfScope: [], doneWhen: ["d"] } })), []);
	});

	it("Explore needs a touched or new module", () => {
		assert.deepEqual(missing(at({ phase: "explore", modules: [{ path: "a", role: "context", files: [] }] })), [
			"at least one touched or new module",
		]);
		assert.deepEqual(missing(at({ phase: "explore", modules: [{ path: "a", role: "new", files: [] }] })), []);
	});

	it("Decide needs every decision answered", () => {
		const option = { id: "A", title: "a", pros: [], cons: [], effort: 1 as const, risk: 1 as const };
		assert.deepEqual(missing(at({ phase: "decide", decisions: [{ id: "d1", question: "q", options: [option] }] })), [
			"answers to open decisions d1",
		]);
		assert.deepEqual(missing(at({ phase: "decide" })), []);
	});

	it("Design needs a diagram drawn in Design; Blueprint needs nothing extra", () => {
		const diagram = (phase: "explore" | "design") => ({ id: "d1", phase, title: "t", body: "a ──▶ b" });
		assert.deepEqual(missing(at({ phase: "design" })), ["at least one diagram"]);
		assert.deepEqual(missing(at({ phase: "design", diagrams: [diagram("explore")] })), ["at least one diagram"]);
		assert.deepEqual(missing(at({ phase: "design", diagrams: [diagram("design")] })), []);
		assert.deepEqual(missing(at({ phase: "blueprint" })), []);
	});

	it("Slice needs slices with verify steps and a valid graph", () => {
		assert.deepEqual(missing(at({ phase: "slice" })), ["at least one slice"]);
		assert.deepEqual(missing(at({ phase: "slice", slices: [slice("s1", ["s2"], [])] })), [
			"a verify step for s1",
			"s1 depends on unknown slice s2",
		]);
		assert.deepEqual(missing(at({ phase: "slice", slices: [slice("s1")] })), []);
	});
});

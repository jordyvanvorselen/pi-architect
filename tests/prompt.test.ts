import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { architectSection, MODE_MESSAGE, modeNotice, modeToldToModel, phaseGuidance } from "../src/prompt.ts";
import { newArchitecture } from "../src/state/reducer.ts";
import { PHASES } from "../src/state/phases.ts";
import { phaseTools } from "../src/tools/common.ts";
import type { Architecture } from "../src/state/types.ts";

function at(partial: Partial<Architecture> = {}): Architecture {
	return { ...newArchitecture(1, "Dedupe", "dedupe"), ...partial };
}

describe("phase guidance", () => {
	it("gives every phase a few short lines", () => {
		for (const phase of PHASES) {
			const lines = phaseGuidance(phase);
			assert.ok(lines.length >= 1 && lines.length <= 3, phase);
			for (const line of lines) assert.ok(line.length < 200, line);
		}
	});

	it("names the tool of each phase, and only tools that are active in it", () => {
		assert.match(phaseGuidance("decide")[0]!, /architect_decide/);
		assert.match(phaseGuidance("design")[0]!, /architect_diagram.*\[new\]/);
		assert.match(phaseGuidance("slice")[0]!, /architect_slice/);
		for (const phase of PHASES) {
			const active = phaseTools({ ...at(), phase });
			for (const tool of phaseGuidance(phase)
				.join(" ")
				.match(/architect_[a-z]+/g) ?? [])
				assert.ok(active.includes(tool), `${phase} names ${tool}, which is off there`);
		}
	});

	it("asks for tests in each slice, every touched file, and an order for slices on the same file", () => {
		const slice = phaseGuidance("slice").join(" ");
		assert.match(slice, /tests in the same slice, not in a last testing slice/);
		assert.match(
			slice,
			/List every file a slice touches\. Slices that change the same file must depend on each other\./,
		);
	});

	it("asks the agent to name an unnamed feature in Frame", () => {
		assert.match(phaseGuidance("frame", at({ feature: "" }))[0]!, /architect_update\(\{ feature \}\)/);
		assert.doesNotMatch(phaseGuidance("frame", at()).join(" "), /no name yet/);
	});
});

describe("architectSection", () => {
	it("is absent in build mode or without an architecture", () => {
		assert.equal(architectSection({ mode: "build", architecture: at() }), undefined);
		assert.equal(architectSection({ mode: "architect" }), undefined);
	});

	it("states the feature, the phase, what to do and the rules", () => {
		const text = architectSection({ mode: "architect", architecture: at({ phase: "explore" }) })!;
		assert.match(
			text,
			/^You are in architect mode, designing one feature before anyone builds it\. Feature: "Dedupe"\./,
		);
		assert.match(text, /\nPhase 2\/6: Explore\.\n- Read the code/);
		assert.match(
			text,
			/Rules:\n- Architect mode designs, it does not build\. Change nothing yet: no file edits, no commands that write, and no changes in other systems like tickets or pull requests, unless the user asks for it\..*Put each change in the design instead\./,
		);
		assert.doesNotMatch(text, /skip/i);
		const rules = text.split("\nDrawing diagrams")[0]!;
		assert.ok(rules.length < 1200, `section is ${rules.length} characters without the drawing guide`);
	});

	it("says when the phase waits for review", () => {
		const text = architectSection({ mode: "architect", architecture: at({ status: "review" }) })!;
		assert.match(text, /Phase 1\/6: Frame, waiting for review\. Call architect_advance to reopen it\./);
	});

	it("says the plan is final once approved", () => {
		const text = architectSection({ mode: "architect", architecture: at({ feature: "", approvedAt: 3 }) })!;
		assert.match(text, /Feature: not named yet\./);
		assert.match(text, /plan is final/);
		assert.match(text, /\/architect build/);
	});
});

describe("mode notices", () => {
	it("are short and say what changed", () => {
		assert.equal(
			modeNotice("architect", at({ phase: "decide" })),
			"[pi-architect] The user switched to architect mode. Architect mode designs, it does not build. Change nothing yet: no file edits, no commands that write, and no changes in other systems like tickets or pull requests, unless the user asks for it. Reading, searching and commands that only look, like running the tests, are fine. Put each change in the design instead. Current phase: Decide.",
		);
		assert.doesNotMatch(modeNotice("architect", at({ approvedAt: 1 })), /Current phase/);
		assert.equal(
			modeNotice("build", undefined),
			"[pi-architect] The user switched to build mode. You may change files again, and the architect tools are off.",
		);
		assert.match(modeNotice("build", at({ approvedAt: 1 })), /Build from the approved plan\.$/);
	});

	it("the model last heard the mode of the latest notice on the branch, and build before any", () => {
		const notice = (mode: unknown) => ({ type: "custom_message", customType: MODE_MESSAGE, details: { mode } });
		assert.equal(modeToldToModel([]), "build");
		assert.equal(modeToldToModel([notice("architect")]), "architect");
		assert.equal(modeToldToModel([notice("architect"), notice("build")]), "build");
		assert.equal(
			modeToldToModel([notice("architect"), notice("nonsense"), { type: "custom_message", customType: "other" }]),
			"architect",
		);
	});
});

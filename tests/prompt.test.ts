import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { architectSection, MODE_MESSAGE, modeNotice, modeToldToModel, phaseGuidance } from "../src/prompt.ts";
import { newArchitecture } from "../src/state/reducer.ts";
import { PHASES } from "../src/state/phases.ts";
import type { Architecture } from "../src/state/types.ts";

const all = () => true;
const none = () => false;

function at(partial: Partial<Architecture> = {}): Architecture {
	return { ...newArchitecture(1, "Dedupe", "dedupe"), ...partial };
}

describe("phase guidance", () => {
	it("gives every phase a few short lines", () => {
		for (const phase of PHASES) {
			const lines = phaseGuidance(phase, all);
			assert.ok(lines.length >= 1 && lines.length <= 3, phase);
			for (const line of lines) assert.ok(line.length < 200, line);
		}
	});

	it("names later tools only when they exist", () => {
		assert.match(phaseGuidance("decide", all)[0]!, /architect_decide/);
		assert.doesNotMatch(phaseGuidance("decide", none)[0]!, /architect_decide/);
		assert.match(phaseGuidance("design", all)[0]!, /architect_diagram.*\[new\]/);
		assert.doesNotMatch(phaseGuidance("design", none)[0]!, /architect_diagram/);
		assert.match(phaseGuidance("slice", all)[0]!, /architect_slice/);
		assert.doesNotMatch(phaseGuidance("slice", none)[0]!, /architect_slice/);
	});

	it("asks the agent to name an unnamed feature in Frame", () => {
		assert.match(phaseGuidance("frame", all, at({ feature: "" }))[0]!, /architect_update\(\{ feature \}\)/);
		assert.doesNotMatch(phaseGuidance("frame", all, at()).join(" "), /no name yet/);
	});
});

describe("architectSection", () => {
	it("is absent in build mode or without an architecture", () => {
		assert.equal(architectSection({ mode: "build", architecture: at() }, all), undefined);
		assert.equal(architectSection({ mode: "architect" }, all), undefined);
	});

	it("states the feature, the phase, what to do and the rules", () => {
		const text = architectSection({ mode: "architect", architecture: at({ phase: "explore" }) }, all)!;
		assert.match(
			text,
			/^You are in architect mode, designing one feature before anyone builds it\. Feature: "Dedupe"\./,
		);
		assert.match(text, /\nPhase 2\/6: Explore\.\n- Read the code/);
		assert.match(text, /Rules:\n- Architect mode is read-only/);
		assert.match(text, /call architect_advance/);
		const rules = text.split("\nDrawing diagrams")[0]!;
		assert.ok(rules.length < 1200, `section is ${rules.length} characters without the drawing guide`);
	});

	it("says when the phase waits for review", () => {
		const text = architectSection({ mode: "architect", architecture: at({ status: "review" }) }, all)!;
		assert.match(text, /Phase 1\/6: Frame, waiting for review\. Call architect_advance to reopen it\./);
	});

	it("says the plan is final once approved", () => {
		const text = architectSection({ mode: "architect", architecture: at({ feature: "", approvedAt: 3 }) }, all)!;
		assert.match(text, /Feature: not named yet\./);
		assert.match(text, /plan is final/);
		assert.match(text, /\/mode build/);
	});
});

describe("mode notices", () => {
	it("are short and say what changed", () => {
		assert.equal(
			modeNotice("architect", at({ phase: "decide" })),
			"[pi-architect] The user switched to architect mode. It is read-only: edit and write are off. Current phase: Decide.",
		);
		assert.doesNotMatch(modeNotice("architect", at({ approvedAt: 1 })), /Current phase/);
		assert.equal(
			modeNotice("build", undefined),
			"[pi-architect] The user switched to build mode. All tools are back and the architect tools are off.",
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

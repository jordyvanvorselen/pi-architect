import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPhase, nextPhase, PHASE_LABEL, PHASE_SHORT, phaseIndex, PHASES } from "../src/state/phases.ts";

describe("phases", () => {
	it("run from frame to blueprint", () => {
		assert.deepEqual(PHASES, ["frame", "explore", "decide", "design", "slice", "blueprint"]);
	});

	it("each phase leads to the next one and blueprint is the last", () => {
		assert.equal(nextPhase("frame"), "explore");
		assert.equal(nextPhase("design"), "slice");
		assert.equal(nextPhase("slice"), "blueprint");
		assert.equal(nextPhase("blueprint"), undefined);
	});

	it("know their position", () => {
		assert.deepEqual(
			PHASES.map((p) => phaseIndex(p)),
			[0, 1, 2, 3, 4, 5],
		);
	});

	it("have a label and a distinct three-letter short name each", () => {
		assert.equal(PHASE_LABEL.decide, "Decide");
		const shorts = PHASES.map((p) => PHASE_SHORT[p]);
		assert.equal(new Set(shorts).size, PHASES.length);
		for (const short of shorts) assert.equal(short.length, 3);
	});

	it("recognise phase names and reject anything else", () => {
		assert.equal(isPhase("slice"), true);
		assert.equal(isPhase("Slice"), false);
		assert.equal(isPhase(3), false);
	});
});

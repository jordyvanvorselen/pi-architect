import assert from "node:assert/strict";
import { test } from "node:test";
import { nextPhase, PHASES } from "../src/phases.ts";

test("phases run from frame to slice", () => {
	assert.deepEqual(PHASES, ["frame", "explore", "decide", "design", "slice"]);
});

test("each phase leads to the next one", () => {
	assert.equal(nextPhase("frame"), "explore");
	assert.equal(nextPhase("design"), "slice");
});

test("slice is the last phase", () => {
	assert.equal(nextPhase("slice"), undefined);
});

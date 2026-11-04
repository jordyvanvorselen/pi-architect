import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ENTRY_TYPE } from "../src/index.ts";
import type { ReviewUi } from "../src/review.ts";
import { rebuild } from "../src/state/reducer.ts";
import { harness } from "./harness.ts";
import { FakeUi } from "./helpers.ts";

const ev = (data: Record<string, unknown>) => ({ type: "custom", customType: ENTRY_TYPE, data: { v: 1, ...data } });

/** A Frame that the agent sent to review, and Pi quit before the user answered. */
const inReview = () => [
	ev({ type: "begin", feature: "Dedupe", slug: "dedupe", at: 1 }),
	ev({ type: "mode", mode: "architect", at: 1, turnedOff: ["edit", "write"] }),
	ev({ type: "update", phase: "frame", brief: { goal: "g", doneWhen: ["d"] } }),
	ev({ type: "submit", phase: "frame", at: 2 }),
];

describe("loading a session", () => {
	it("withdraws a review that nobody waits for after Pi quit during it", async () => {
		const h = harness({ ui: new FakeUi(), branch: inReview() });
		assert.equal(rebuild(h.branch).architecture!.status, "review");
		await h.fire("session_start", { reason: "resume" });
		assert.deepEqual(h.entries.at(-1)!.data, { v: 1, type: "withdraw", phase: "frame", at: h.entries.at(-1)!.data.at });
		assert.equal(rebuild(h.branch).architecture!.status, "working");
	});

	it("keeps a review in review while the agent is still running", async () => {
		const h = harness({ ui: new FakeUi(), branch: inReview() });
		(h.ctx as { isIdle: () => boolean }).isIdle = () => false;
		await h.fire("session_tree", {});
		assert.deepEqual(h.entries, []);
	});

	it("keeps the review that a tool is waiting for when the branch is loaded again", async () => {
		let reload = async () => {};
		const review: ReviewUi = async () => {
			await reload();
			return { verdict: "approved" };
		};
		const h = harness({ ui: new FakeUi(), overrides: { review } });
		reload = async () => {
			await h.fire("session_tree", {});
		};
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect");
		await h.call("architect_update", { feature: "Dedupe", brief: { goal: "g", done_when: ["d"] } });
		await h.call("architect_advance", {});
		assert.deepEqual(
			h.entries.map((e) => e.data.type),
			["mode", "update", "submit", "verdict"],
		);
		assert.equal(rebuild(h.branch).architecture!.phase, "explore");
	});

	it("leaves a working phase alone", async () => {
		const h = harness({ ui: new FakeUi(), branch: inReview().slice(0, 3) });
		await h.fire("session_start", { reason: "resume" });
		assert.deepEqual(h.entries, []);
	});
});

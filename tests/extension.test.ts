import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ENTRY_TYPE, FLAG, SHORTCUT, WIDGET_KEY } from "../src/index.ts";
import { MODE_MESSAGE, SECTION } from "../src/prompt.ts";
import { rebuild } from "../src/state/reducer.ts";
import { STATUS_KEY } from "../src/ui/status.ts";
import { harness } from "./harness.ts";
import { assertComponentFits, FakeUi, plainTheme } from "./helpers.ts";

const events = (h: ReturnType<typeof harness>) => h.entries.map((e) => e.data.type);

/** A slice that passes architect_slice's checks. */
const SLICE = {
	id: "s1",
	title: "Store the key",
	goal: "Events carry a key.",
	files: ["src/key.ts"],
	steps: ["Add dedupKey() to src/key.ts"],
	verify: ["npm test"],
};

async function architecting(ui = new FakeUi()) {
	const h = harness({ ui });
	await h.fire("session_start", { reason: "startup" });
	await h.command("mode", "architect");
	return h;
}

describe("registration", () => {
	it("registers the architect tools inactive, with prompt text that names each tool", () => {
		const h = harness();
		for (const name of [
			"architect_update",
			"architect_advance",
			"architect_decide",
			"architect_diagram",
			"architect_slice",
		]) {
			const tool = h.tools[name]!;
			assert.equal(tool.defaultActive, false);
			assert.ok(tool.promptSnippet);
			assert.ok(tool.promptGuidelines?.length);
			for (const line of tool.promptGuidelines!) assert.match(line, new RegExp(name));
		}
		assert.equal(h.tools.architect_advance!.executionMode, "sequential");
		assert.deepEqual(Object.keys(h.commands).sort(), ["architect", "mode", "plan"]);
		assert.ok(h.shortcuts[SHORTCUT]);
		assert.ok(h.flags[FLAG]);
		assert.ok(!h.active().some((n) => n.startsWith("architect_")));
	});

	it("completes mode names and the architect subcommand", () => {
		const h = harness();
		const modes = h.commands.mode!.getArgumentCompletions!("") as { value: string }[];
		assert.deepEqual(
			modes.map((m) => m.value),
			["architect", "build"],
		);
		assert.deepEqual(
			(h.commands.mode!.getArgumentCompletions!("b") as { value: string }[]).map((m) => m.value),
			["build"],
		);
		assert.equal(h.commands.mode!.getArgumentCompletions!("x"), null);
		assert.deepEqual(
			(h.commands.architect!.getArgumentCompletions!("re") as { value: string }[]).map((m) => m.value),
			["reset"],
		);
		assert.equal(h.commands.architect!.getArgumentCompletions!("dedupe"), null);
	});
});

describe("modes", () => {
	it("starts in build mode and shows it in the footer", async () => {
		const ui = new FakeUi();
		const h = harness({ ui });
		await h.fire("session_start", { reason: "startup" });
		assert.equal(ui.statuses.get(STATUS_KEY), "▸ build");
		assert.equal(ui.widgets.get(WIDGET_KEY), undefined);
		assert.deepEqual(h.entries, []);
	});

	it("architect mode turns edit and write off, the architect tools on and shows the stepper", async () => {
		const h = await architecting();
		assert.deepEqual(events(h), ["mode"]);
		const active = h.active();
		assert.ok(!active.includes("edit") && !active.includes("write"));
		assert.ok(active.includes("architect_update") && active.includes("architect_advance"));
		assert.ok(active.includes("read") && active.includes("bash"));
		assert.equal(h.ui!.statuses.get(STATUS_KEY), "◆ architect · Frame");
		assert.match(h.ui!.widgetLines(WIDGET_KEY)![0]!, /◆ ARCHITECT {2}● Frame ┄┄ Explore/);
		assertComponentFits(h.ui!.widgets.get(WIDGET_KEY) as never);
	});

	it("build mode brings back exactly the tools architect mode turned off", async () => {
		const h = harness({ ui: new FakeUi(), builtins: ["read", "bash", "write"] });
		await h.fire("session_start", { reason: "startup" });
		await h.command("mode", "architect");
		await h.command("mode", "build");
		assert.deepEqual(h.active().sort(), ["bash", "read", "write"]);
		assert.equal(h.ui!.statuses.get(STATUS_KEY), "▸ build");
		assert.equal(h.ui!.widgets.get(WIDGET_KEY), undefined);
	});

	it("leaving an unapproved architecture asks first, and declining keeps architect mode", async () => {
		const ui = new FakeUi({ confirm: [false, true] });
		const h = await architecting(ui);
		await h.call("architect_update", { brief: { goal: "Fewer duplicate alarms" } });
		await h.command("mode", "build");
		assert.equal(rebuild(h.branch).mode, "architect");
		assert.match(ui.prompts[0]!.detail as string, /The plan is not approved yet\. Switch to build anyway\?/);
		await h.command("mode", "build");
		assert.equal(rebuild(h.branch).mode, "build");
		assert.ok(ui.done);
	});

	it("leaves an empty architecture without asking, and resumes at the same phase when coming back", async () => {
		const ui = new FakeUi({ select: ["Approve Frame"] });
		const h = await architecting(ui);
		await h.command("mode", "build");
		assert.equal(ui.prompts.length, 0);
		await h.command("mode", "architect");
		await h.call("architect_update", { feature: "Dedupe", brief: { goal: "g", done_when: ["d"] } });
		await h.call("architect_advance", {});
		ui.script({ confirm: [true] });
		await h.command("mode", "build");
		await h.command("mode", "architect");
		assert.equal(rebuild(h.branch).architecture!.phase, "explore");
		assert.equal(ui.statuses.get(STATUS_KEY), "◆ architect · Explore");
	});

	it("/mode without arguments offers a choice", async () => {
		const ui = new FakeUi();
		const h = harness({ ui });
		await h.fire("session_start", { reason: "startup" });
		ui.script({ select: ["○ architect: Design a feature first: read-only, phase by phase"] });
		await h.command("mode");
		assert.equal(ui.prompts[0]!.title, "Mode (now build)");
		assert.equal(rebuild(h.branch).mode, "architect");
		ui.script({ select: [undefined] });
		await h.command("mode");
		assert.equal(rebuild(h.branch).mode, "architect");
	});

	it("rejects an unknown mode and says when the mode does not change", async () => {
		const ui = new FakeUi();
		const h = harness({ ui });
		await h.fire("session_start", { reason: "startup" });
		await h.command("mode", "turbo");
		await h.command("mode", "build");
		assert.deepEqual(
			ui.notifications.map((n) => [n.message, n.type]),
			[
				['Unknown mode "turbo". Use /mode architect or /mode build.', "error"],
				["Already in build mode.", "info"],
			],
		);
		assert.deepEqual(h.entries, []);
	});

	it("the shortcut toggles the mode", async () => {
		const h = harness({ ui: new FakeUi() });
		await h.fire("session_start", { reason: "startup" });
		await h.shortcuts[SHORTCUT]!(h.ctx);
		assert.equal(rebuild(h.branch).mode, "architect");
		await h.shortcuts[SHORTCUT]!(h.ctx);
		assert.equal(rebuild(h.branch).mode, "build");
	});

	it("the --architect flag starts in architect mode, once", async () => {
		const h = harness({ ui: new FakeUi(), flags: { [FLAG]: true } });
		await h.fire("session_start", { reason: "startup" });
		assert.deepEqual(events(h), ["mode"]);
		await h.fire("session_start", { reason: "reload" });
		assert.deepEqual(events(h), ["mode"]);
	});

	it("headless sessions switch without asking", async () => {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		await h.command("mode", "architect");
		await h.call("architect_update", { brief: { goal: "g" } });
		await h.command("mode", "build");
		assert.equal(rebuild(h.branch).mode, "build");
	});

	it("RPC clients get the stepper as plain lines", async () => {
		const h = harness({ ui: new FakeUi(), mode: "rpc" });
		await h.fire("session_start", { reason: "startup" });
		await h.command("mode", "architect");
		const widget = h.ui!.widgets.get(WIDGET_KEY);
		assert.ok(Array.isArray(widget));
		assert.match(widget[0]!, /◆ ARCHITECT/);
	});
});

describe("persistence", () => {
	it("rebuilds the mode and the tools from the branch after a reload", async () => {
		const first = await architecting();
		await first.call("architect_update", { feature: "Dedupe" });
		const ui = new FakeUi();
		const second = harness({ ui, branch: [...first.branch] });
		await second.fire("session_start", { reason: "reload" });
		assert.ok(!second.active().includes("edit"));
		assert.ok(second.active().includes("architect_update"));
		assert.match(ui.widgetLines(WIDGET_KEY)![0]!, /◆ ARCHITECT {2}Dedupe {2}● Frame/);
	});

	it("rebuilds on /tree navigation, so a fork is a what-if branch", async () => {
		const h = await architecting();
		const forkPoint = h.branch.length;
		await h.call("architect_update", { risks: [{ text: "ordering" }] });
		assert.match(h.ui!.widgetLines(WIDGET_KEY)![0]!, /⚠ 1 risk/);
		h.branch.splice(forkPoint);
		await h.fire("session_tree", {});
		assert.doesNotMatch(h.ui!.widgetLines(WIDGET_KEY)![0]!, /risk/);
	});

	it("shows the plan placeholder in build mode once the plan is approved", async () => {
		const ui = new FakeUi();
		const branch = [
			{
				type: "custom",
				customType: ENTRY_TYPE,
				data: { v: 1, type: "begin", feature: "Dedupe", slug: "dedupe", at: 1 },
			},
			...["frame", "explore", "decide", "design", "slice", "blueprint"].map((phase) => ({
				type: "custom",
				customType: ENTRY_TYPE,
				data: { v: 1, type: "verdict", phase, verdict: "approved", at: 2 },
			})),
		];
		const h = harness({ ui, branch });
		await h.fire("session_start", { reason: "resume" });
		assert.equal(ui.statuses.get(STATUS_KEY), "▸ build · plan approved");
		assert.deepEqual(ui.widgetLines(WIDGET_KEY), [" ▸ BUILD  plan: dedupe  plan not written · /plan write"]);
	});
});

describe("/architect", () => {
	it("names the feature, enters architect mode and starts the agent on Frame", async () => {
		const h = harness({ ui: new FakeUi() });
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "Dedupe panel events");
		assert.deepEqual(events(h), ["begin", "mode"]);
		assert.equal(h.entries[0]!.data.slug, "dedupe-panel-events");
		assert.equal(h.sent.length, 1);
		assert.equal(
			h.sent[0]!.message.content,
			"Architect this feature: Dedupe panel events. Start with the Frame phase.",
		);
		assert.deepEqual(h.sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
	});

	it("without a feature it only enters architect mode", async () => {
		const h = harness({ ui: new FakeUi() });
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect");
		assert.deepEqual(events(h), ["mode"]);
		assert.equal(h.sent.length, 0);
	});

	it("names an unnamed architecture that already has content, without starting over", async () => {
		const h = await architecting();
		await h.call("architect_update", { brief: { goal: "g" } });
		await h.command("architect", "Dedupe");
		const arch = rebuild(h.branch).architecture!;
		assert.equal(arch.feature, "Dedupe");
		assert.equal(arch.brief.goal, "g");
		assert.equal(h.sent.length, 0);
	});

	it("asks before replacing an architecture with content, and resumes the same feature without asking", async () => {
		const ui = new FakeUi({ confirm: [false, true] });
		const h = harness({ ui });
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "Dedupe");
		await h.call("architect_update", { brief: { goal: "g" } });
		await h.command("architect", "Dedupe");
		assert.equal(ui.prompts.length, 0);
		await h.command("architect", "Other");
		assert.equal(rebuild(h.branch).architecture!.feature, "Dedupe");
		await h.command("architect", "Other");
		assert.equal(rebuild(h.branch).architecture!.feature, "Other");
		assert.equal(ui.prompts[1]!.detail, 'This discards the architecture for "Dedupe".');
	});

	it("refuses to replace an architecture without a UI to confirm", async () => {
		const notes: string[] = [];
		const h = harness();
		(h.ctx.ui as { notify: (m: string) => void }).notify = (m) => notes.push(m);
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "Dedupe");
		await h.call("architect_update", { brief: { goal: "g" } });
		await h.command("architect", "Other");
		assert.deepEqual(notes, ['Already architecting "Dedupe". Run /architect reset first.']);
	});

	it("reset discards the architecture after a confirmation", async () => {
		const ui = new FakeUi({ confirm: [false, true] });
		const h = harness({ ui });
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "reset");
		assert.equal(ui.notifications[0]!.message, "There is no architecture to discard.");
		await h.command("architect", "Dedupe");
		await h.command("architect", "reset");
		assert.equal(rebuild(h.branch).architecture!.feature, "Dedupe");
		await h.command("architect", "reset");
		assert.equal(rebuild(h.branch).architecture!.feature, "");
		assert.equal(ui.prompts[1]!.detail, 'This discards the architecture for "Dedupe".');
	});
});

describe("read-only mode", () => {
	it("blocks writes only in architect mode", async () => {
		const h = harness({ ui: new FakeUi() });
		await h.fire("session_start", { reason: "startup" });
		assert.equal(await h.toolCall("bash", { command: "rm -rf x" }), undefined);
		await h.command("mode", "architect");
		const blocked = await h.toolCall("bash", { command: "ls && rm -rf x" });
		assert.equal(blocked?.block, true);
		assert.match(blocked!.reason, /rm is not a read-only command/);
		assert.equal((await h.toolCall("edit", { path: "x" }))?.block, true);
		assert.equal(await h.toolCall("bash", { command: "git status" }), undefined);
		assert.equal(await h.toolCall("read", { path: "x" }), undefined);
	});
});

describe("guidance for the model", () => {
	it("adds the phase section in architect mode and removes it in build mode", async () => {
		const h = await architecting();
		const run = await h.startRun();
		assert.match(run.sections[SECTION]!, /Phase 1\/6: Frame/);
		await h.command("mode", "build");
		const sections: Record<string, string> = { [SECTION]: "stale" };
		await h.fire("before_agent_start", { messageType: "user", systemPromptOptions: { sections } });
		assert.equal(sections[SECTION], undefined);
	});

	it("tells the model about a mode switch once", async () => {
		const h = await architecting();
		const first = await h.startRun();
		assert.equal(first.message?.customType, MODE_MESSAGE);
		assert.match(first.message!.content, /switched to architect mode/);
		assert.equal((await h.startRun()).message, undefined);
		await h.command("mode", "build");
		assert.match((await h.startRun()).message!.content, /switched to build mode/);
		assert.equal((await h.startRun("custom")).message, undefined);
	});

	it("does not mention build mode to a model that never left it", async () => {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		assert.deepEqual(await h.startRun(), { sections: {}, message: undefined });
	});
});

describe("architect_update", () => {
	it("records phase content and answers briefly", async () => {
		const h = await architecting();
		const result = await h.call("architect_update", {
			feature: "Dedupe",
			brief: { goal: "Fewer duplicate alarms", doneWhen: "no duplicates in the panel" },
		});
		assert.equal(
			result.content[0]!.text,
			'Updated named "Dedupe", brief: goal, 1 done-when. Frame is ready: call architect_advance when the user should review it.',
		);
		assert.equal(rebuild(h.branch).architecture!.brief.doneWhen[0], "no duplicates in the panel");
		assert.match(h.ui!.widgetLines(WIDGET_KEY)![0]!, /Dedupe/);
	});

	it("only works in architect mode", async () => {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		await assert.rejects(h.call("architect_update", { risks: [{ text: "x" }] }), /only works in architect mode/);
	});

	it("renders its call and result compactly", async () => {
		const h = await architecting();
		const tool = h.tools.architect_update!;
		const args = { brief: { goal: "g" }, risks: [{ text: "x" }] };
		const call = tool.renderCall!(args, plainTheme, { lastComponent: undefined, isError: false });
		assert.deepEqual(call.render(80).map(stripTerminalSequences), ["◆ architect update  brief · 1 risk".padEnd(80)]);
		const result = await h.call("architect_update", args);
		const rendered = tool.renderResult!(result, { expanded: false, isPartial: false }, plainTheme, {
			lastComponent: call,
			isError: false,
		});
		assert.equal(rendered, call);
		assert.match(stripTerminalSequences(rendered.render(120)[0]!), /^✓ brief: goal · \+1 risk \(r1\) · Frame needs/);
	});
});

describe("architect_advance", () => {
	it("explains what is missing without bothering the user", async () => {
		const h = await architecting();
		const result = await h.call("architect_advance", {});
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /Frame is not ready for review\. It still needs a feature name, the goal/);
		assert.equal(h.ui!.prompts.length, 0);
	});

	it("approval moves on and hands the model the next phase's guidance", async () => {
		const ui = new FakeUi({ select: ["Approve Frame"] });
		const h = await architecting(ui);
		await h.call("architect_update", { feature: "Dedupe", brief: { goal: "g", done_when: ["d"] } });
		const result = await h.call("architect_advance", { summary: "Check the scope" });
		assert.match(result.content[0]!.text, /^Frame approved\. Now in Explore \(phase 2\/6\):\n- Read the code/);
		assert.match(ui.prompts[0]!.title, /^Review Frame: Check the scope\n\nFeature: Dedupe\nGoal: g/);
		assert.deepEqual(events(h).slice(-2), ["submit", "verdict"]);
		assert.equal(ui.statuses.get(STATUS_KEY), "◆ architect · Explore");
	});

	it("requested changes return the user's comment", async () => {
		const ui = new FakeUi({ select: ["Request changes"], input: ["  tighten the scope "] });
		const h = await architecting(ui);
		await h.call("architect_update", { feature: "Dedupe", brief: { goal: "g", done_when: ["d"] } });
		const result = await h.call("architect_advance", {});
		assert.equal(
			result.content[0]!.text,
			'The user requested changes to Frame: "tighten the scope". Revise Frame, then call architect_advance again.',
		);
		assert.equal(rebuild(h.branch).architecture!.phase, "frame");
	});

	it("a closed review stops the agent and puts the phase back to working", async () => {
		const ui = new FakeUi({ select: [undefined] });
		const h = await architecting(ui);
		await h.call("architect_update", { feature: "Dedupe", brief: { goal: "g", done_when: ["d"] } });
		const result = await h.call("architect_advance", {});
		assert.equal(result.terminate, true);
		assert.equal(result.details?.outcome, "closed");
		assert.equal(rebuild(h.branch).architecture!.status, "working");
	});

	it("takes a custom review screen, and approving the Blueprint makes the plan final", async () => {
		const seen: string[] = [];
		const h = harness({
			ui: new FakeUi(),
			overrides: {
				review: async ({ phase, arch }) => {
					seen.push(`${phase}:${arch.status}`);
					return { verdict: "approved", comment: phase === "blueprint" ? "ship it" : "" };
				},
			},
			builtins: ["read", "bash"],
		});
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "Dedupe");
		await h.call("architect_update", { brief: { goal: "g", done_when: ["d"] } });
		await h.call("architect_advance", {});
		await h.call("architect_update", { modules: [{ path: "src/ingest", role: "touched" }] });
		for (let i = 0; i < 2; i++) await h.call("architect_advance", {});
		await h.call("architect_diagram", { title: "Flow", body: "A ──▶ B" });
		await h.call("architect_advance", {});
		await h.call("architect_slice", { slices: [SLICE] });
		await h.call("architect_advance", {});
		const final = await h.call("architect_advance", {});
		assert.deepEqual(seen, [
			"frame:review",
			"explore:review",
			"decide:review",
			"design:review",
			"slice:review",
			"blueprint:review",
		]);
		assert.equal(final.details?.final, true);
		assert.match(
			final.content[0]!.text,
			/The user approved the Blueprint\. The plan is final\. The user added: "ship it"/,
		);
		assert.equal(final.details?.planPath, join("docs", "plans", "dedupe.md"));
		assert.match(final.content[0]!.text, /It is saved at docs\/plans\/dedupe\.md\./);
		assert.equal(h.ui!.statuses.get(STATUS_KEY), "◆ architect · plan approved");
		await assert.rejects(h.call("architect_advance", {}), /already approved/);
	});

	it("withdraws the submit when the review screen fails", async () => {
		const h = harness({
			ui: new FakeUi(),
			overrides: {
				review: async () => {
					throw new Error("screen broke");
				},
			},
		});
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "Dedupe");
		await h.call("architect_update", { brief: { goal: "g", done_when: ["d"] } });
		await assert.rejects(h.call("architect_advance", {}), /screen broke/);
		assert.equal(rebuild(h.branch).architecture!.status, "working");
	});

	it("treats an interrupted review as closed", async () => {
		const controller = new AbortController();
		const h = harness({
			ui: new FakeUi(),
			overrides: {
				review: async () => {
					controller.abort();
					return { verdict: "approved" };
				},
			},
		});
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "Dedupe");
		await h.call("architect_update", { brief: { goal: "g", done_when: ["d"] } });
		const result = await h.call("architect_advance", {}, controller.signal);
		assert.equal(result.details?.outcome, "closed");
	});

	it("headless sessions cannot review and stop the agent", async () => {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "Dedupe");
		await h.call("architect_update", { brief: { goal: "g", done_when: ["d"] } });
		const result = await h.call("architect_advance", {});
		assert.equal(result.details?.outcome, "no-ui");
		assert.equal(result.terminate, true);
		assert.deepEqual(events(h), ["begin", "mode", "update"]);
	});

	it("only works in architect mode", async () => {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		await assert.rejects(h.call("architect_advance", {}), /only works in architect mode/);
	});

	it("renders a waiting state and the outcome", async () => {
		const ui = new FakeUi({ select: ["Approve Frame"] });
		const h = await architecting(ui);
		const tool = h.tools.architect_advance!;
		const ctx = { lastComponent: undefined, isError: false };
		const call = tool.renderCall!({ summary: "Check the scope" }, plainTheme, ctx);
		assert.equal(stripTerminalSequences(call.render(60)[0]!).trimEnd(), "◆ architect advance  Check the scope");
		const waiting = tool.renderResult!(
			{ content: [], details: undefined },
			{ expanded: false, isPartial: true },
			plainTheme,
			ctx,
		);
		assert.match(waiting.render(60)[0]!, /waiting for your review/);
		await h.call("architect_update", { feature: "Dedupe", brief: { goal: "g", done_when: ["d"] } });
		const result = await h.call("architect_advance", {});
		const done = tool.renderResult!(result, { expanded: false, isPartial: false }, plainTheme, ctx);
		assert.equal(stripTerminalSequences(done.render(60)[0]!).trimEnd(), "✓ Frame approved → Explore");
	});
});

describe("transcript entries", () => {
	it("renders mode switches, a new feature and a reset, and hides the rest", () => {
		const h = harness();
		const render = (data: unknown) => {
			const component = h.entryRenderers[ENTRY_TYPE]!(
				{ type: "custom", customType: ENTRY_TYPE, data },
				{ expanded: false },
				plainTheme,
			) as { render(width: number): string[] } | undefined;
			return component?.render(120).map((l) => stripTerminalSequences(l).trimEnd());
		};
		assert.deepEqual(render({ v: 1, type: "mode", mode: "architect", at: 1 }), [
			"◆ architect mode  read-only · the agent walks through the phases, you approve each one",
		]);
		assert.deepEqual(render({ v: 1, type: "mode", mode: "build", at: 1 }), ["▸ build mode  all tools are back"]);
		assert.deepEqual(render({ v: 1, type: "begin", feature: "Dedupe", slug: "dedupe", at: 1 }), [
			'◆ architecting "Dedupe"',
		]);
		assert.deepEqual(render({ v: 1, type: "reset", at: 1 }), ["■ architecture discarded"]);
		assert.equal(render({ v: 1, type: "update", phase: "frame" }), undefined);
		assert.equal(render(undefined), undefined);
	});
});

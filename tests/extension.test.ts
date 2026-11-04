import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ENTRY_TYPE, FLAG, SHORTCUT, WIDGET_KEY } from "../src/index.ts";
import { KEEP } from "../src/confirm.ts";
import { allowedInArchitect } from "../src/readonly/index.ts";
import { MODE_MESSAGE, SECTION } from "../src/prompt.ts";
import { REVIEW_MESSAGE } from "../src/reopen.ts";
import { rebuild } from "../src/state/reducer.ts";
import { STATUS_KEY } from "../src/ui/status.ts";
import { harness } from "./harness.ts";
import { assertComponentFits, FakeUi, KEYS, plainTheme, type } from "./helpers.ts";

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
	await h.command("architect");
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
		assert.deepEqual(Object.keys(h.commands), ["architect"]);
		assert.ok(h.shortcuts[SHORTCUT]);
		assert.ok(h.flags[FLAG]);
		assert.ok(!h.active().some((n) => n.startsWith("architect_")));
	});

	it("completes the architect subcommands, and the plan actions after plan", () => {
		const h = harness();
		const complete = (prefix: string) =>
			h.commands.architect!.getArgumentCompletions!(prefix) as
				{ value: string; label: string; description: string }[] | null;
		const all = complete("")!;
		assert.deepEqual(
			all.map((i) => i.value),
			["board", "review", "plan", "build", "reset"],
		);
		for (const item of all) assert.ok(item.description);
		assert.deepEqual(
			complete("b")!.map((i) => i.value),
			["board", "build"],
		);
		assert.deepEqual(
			complete("re")!.map((i) => i.value),
			["review", "reset"],
		);
		assert.deepEqual(
			complete("plan ")!.map((i) => [i.value, i.label]),
			[
				["plan open", "open"],
				["plan write", "write"],
				["plan build", "build"],
			],
		);
		assert.deepEqual(
			complete("plan w")!.map((i) => i.value),
			["plan write"],
		);
		assert.equal(complete("plan here"), null);
		assert.equal(complete("dedupe"), null);
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
		await h.command("architect");
		await h.command("architect", "build");
		assert.deepEqual(h.active().sort(), ["bash", "read", "write"]);
		assert.equal(h.ui!.statuses.get(STATUS_KEY), "▸ build");
		assert.equal(h.ui!.widgets.get(WIDGET_KEY), undefined);
	});

	it("leaving an unapproved architecture asks first, and declining keeps architect mode", async () => {
		const ui = new FakeUi({ confirm: [false, true] });
		const h = await architecting(ui);
		await h.call("architect_update", { brief: { goal: "Fewer duplicate alarms" } });
		await h.command("architect", "build");
		assert.equal(rebuild(h.branch).mode, "architect");
		assert.match(ui.prompts[0]!.detail as string, /The plan is not approved yet\. Switch to build anyway\?/);
		await h.command("architect", "build");
		assert.equal(rebuild(h.branch).mode, "build");
		assert.ok(ui.done);
	});

	it("leaves an empty architecture without asking, and resumes at the same phase when coming back", async () => {
		const ui = new FakeUi().keys([KEYS.enter]);
		const h = await architecting(ui);
		await h.command("architect", "build");
		assert.equal(ui.prompts.length, 0);
		await h.command("architect");
		await h.call("architect_update", { feature: "Dedupe", brief: { goal: "g", done_when: ["d"] } });
		await h.call("architect_advance", {});
		ui.script({ confirm: [true] });
		await h.command("architect", "build");
		await h.command("architect");
		assert.equal(rebuild(h.branch).architecture!.phase, "explore");
		assert.equal(ui.statuses.get(STATUS_KEY), "◆ architect · Explore");
	});

	it("/architect in architect mode offers the board, the plan, build mode and reset", async () => {
		const ui = new FakeUi();
		const h = await architecting(ui);
		await h.call("architect_update", { feature: "Dedupe" });
		ui.script({ select: [undefined] });
		await h.command("architect");
		assert.equal(ui.prompts[0]!.title, "Architect mode: Dedupe");
		assert.deepEqual(ui.prompts[0]!.detail, [
			"Open the board",
			"Plan: path and actions",
			"Switch to build mode",
			"Discard the architecture",
		]);
		assert.deepEqual(events(h), ["mode", "update"]);
		ui.script({ select: ["Switch to build mode"] });
		await h.command("architect");
		assert.equal(rebuild(h.branch).mode, "build");
		await h.command("architect");
		assert.equal(rebuild(h.branch).mode, "architect");
		ui.script({ select: ["Discard the architecture", "Yes, discard it"] });
		await h.command("architect");
		assert.deepEqual(events(h), ["mode", "update", "mode", "mode", "reset"]);
	});

	it("reserves board, plan, build and reset as the first word, and says when the mode does not change", async () => {
		const ui = new FakeUi();
		const h = harness({ ui });
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "build pipeline");
		await h.command("architect", "Reset now");
		await h.command("architect", "build");
		assert.deepEqual(
			ui.notifications.map((n) => [n.message, n.type]),
			[
				[
					'/architect build takes no arguments. For a feature that starts with "build", put it in quotes: /architect "build pipeline".',
					"error",
				],
				[
					'/architect reset takes no arguments. For a feature that starts with "reset", put it in quotes: /architect "reset now".',
					"error",
				],
				["Already in build mode.", "info"],
			],
		);
		assert.deepEqual(h.entries, []);
		await h.command("architect", '"build pipeline"');
		assert.equal(rebuild(h.branch).architecture!.feature, "build pipeline");
	});

	it("asks whether a first word glued to a subcommand meant the subcommand, with the subcommand first", async () => {
		const ui = new FakeUi({ select: [undefined] });
		const h = harness({ ui });
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "board6cSplit the panel");
		assert.equal(ui.prompts[0]!.title, "Did you mean /architect board?");
		assert.deepEqual(ui.prompts[0]!.detail, [
			"Yes, /architect board",
			'Architect "board6cSplit the panel" as a feature',
		]);
		assert.deepEqual(h.entries, []);
		ui.script({ select: ['Architect "Builder cleanup" as a feature'] });
		await h.command("architect", "Builder cleanup");
		assert.equal(rebuild(h.branch).architecture!.feature, "Builder cleanup");
	});

	it("headless, a first word glued to a subcommand starts nothing and says how to name such a feature", async () => {
		const notes: string[] = [];
		const h = harness();
		(h.ctx.ui as { notify: (m: string) => void }).notify = (m) => notes.push(m);
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "Planner");
		assert.deepEqual(notes, [
			'Did you mean /architect plan? For a feature that starts with "plan", put it in quotes: /architect "Planner".',
		]);
		assert.deepEqual(h.entries, []);
		assert.equal(h.sent.length, 0);
	});

	it("headless /architect in architect mode says so instead of a picker", async () => {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect");
		await h.command("architect");
		assert.deepEqual(events(h), ["mode"]);
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
		await h.command("architect");
		await h.call("architect_update", { brief: { goal: "g" } });
		await h.command("architect", "build");
		assert.equal(rebuild(h.branch).mode, "build");
	});

	it("RPC clients get the stepper as plain lines", async () => {
		const h = harness({ ui: new FakeUi(), mode: "rpc" });
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect");
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

	it("brings edit and write back in build mode after a reload restored the architect tool set", async () => {
		const first = await architecting();
		await first.call("architect_update", { feature: "Dedupe" });
		// Pi restores the tools of the last run from the transcript: the architect set, without edit and write.
		const restored = first.active();
		assert.ok(!restored.includes("edit") && !restored.includes("write"));
		const second = harness({ ui: new FakeUi({ confirm: [true] }), branch: [...first.branch], activeTools: restored });
		await second.fire("session_start", { reason: "reload" });
		await second.command("architect", "build");
		assert.ok(second.active().includes("edit") && second.active().includes("write"));
		assert.ok(!second.active().some((n) => n.startsWith("architect_")));
	});

	it("brings edit and write back when a reload lands in build mode with the architect tool set", async () => {
		const first = await architecting();
		const restored = first.active();
		await first.command("architect", "build");
		const second = harness({ ui: new FakeUi(), branch: [...first.branch], activeTools: restored });
		await second.fire("session_tree", {});
		assert.deepEqual(second.active().sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
	});

	it("brings edit and write back after /tree to before architect mode left the architect tool set on", async () => {
		const first = await architecting();
		const restored = first.active();
		// The branch before architect mode: nothing records what architect mode turned off.
		const h = harness({ ui: new FakeUi(), branch: [], activeTools: restored });
		await h.fire("session_tree", {});
		assert.deepEqual(h.active().sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
	});

	it("keeps a write tool off in build mode when the user had it off before architect mode", async () => {
		const h = harness({ ui: new FakeUi(), activeTools: ["read", "bash", "edit"] });
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect");
		assert.deepEqual(h.entries[0]!.data.turnedOff, ["edit"]);
		const restored = h.active();
		const after = harness({ ui: new FakeUi(), branch: [...h.branch], activeTools: restored });
		await after.fire("session_start", { reason: "resume" });
		await after.command("architect", "build");
		assert.ok(after.active().includes("edit"));
		assert.ok(!after.active().includes("write"));
	});

	it("turns off every tool the read-only allowlist does not allow, and back on exactly those in build mode", async () => {
		const builtins = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "mcp__web", "mcp__db"];
		// mcp__db is registered but was off before architect mode, so build mode leaves it off.
		const before = builtins.filter((n) => n !== "mcp__db");
		const h = harness({ ui: new FakeUi(), builtins, activeTools: before });
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect");
		const outside = h.active().filter((n) => !allowedInArchitect(n));
		assert.deepEqual(outside, []);
		assert.deepEqual(
			h
				.active()
				.filter((n) => !n.startsWith("architect_"))
				.sort(),
			["bash", "find", "grep", "ls", "read"],
		);
		// Pi restores the architect tool set after a reload; build mode still knows what to bring back.
		const after = harness({ ui: new FakeUi(), builtins, branch: [...h.branch], activeTools: h.active() });
		await after.fire("session_start", { reason: "reload" });
		await after.command("architect", "build");
		assert.deepEqual(after.active().sort(), [...before].sort());
	});

	it("turns off a tool that turned on during architect mode before the next request, and restores it later", async () => {
		const builtins = ["read", "bash", "edit", "write", "mcp__late"];
		const h = harness({ ui: new FakeUi(), builtins, activeTools: ["read", "bash", "edit", "write"] });
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect");
		// An MCP server connected late, and Pi turned its tool on.
		h.pi.setActiveTools([...h.active(), "mcp__late"]);
		await h.startRun();
		assert.ok(!h.active().includes("mcp__late"));
		assert.deepEqual(h.entries.at(-1)!.data, { v: 1, type: "tools", turnedOff: ["mcp__late"] });
		await h.command("architect", "build");
		assert.deepEqual(h.active().sort(), ["bash", "edit", "mcp__late", "read", "write"]);
	});

	it("turns off a tool that turned on in the middle of a run before the next turn's request", async () => {
		const builtins = ["read", "bash", "edit", "write", "mcp__late"];
		const h = harness({ ui: new FakeUi(), builtins, activeTools: ["read", "bash", "edit", "write"] });
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect");
		await h.startRun();
		h.pi.setActiveTools([...h.active(), "mcp__late"]);
		await h.fire("turn_start", { turnIndex: 1, timestamp: 0 });
		assert.ok(!h.active().includes("mcp__late"));
		assert.deepEqual(h.entries.at(-1)!.data, { v: 1, type: "tools", turnedOff: ["mcp__late"] });
	});

	it("leaves the tools alone in a session that was never in architect mode", async () => {
		const h = harness({ ui: new FakeUi(), activeTools: ["read", "bash"] });
		await h.fire("session_start", { reason: "startup" });
		assert.deepEqual(h.active(), ["read", "bash"]);
		assert.deepEqual(h.activeHistory, []);
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
		assert.deepEqual(ui.widgetLines(WIDGET_KEY), [
			" ▸ BUILD  plan: dedupe  plan not written · /architect plan write                                        ctrl+alt+b board",
		]);
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
		const ui = new FakeUi({ select: [undefined, 'Yes, discard it and architect "Other"'] });
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
		assert.equal(ui.prompts[1]!.title, 'Architect "Other"?\nThis discards the architecture for "Dedupe".');
		// No is first, so a stray ↵ keeps the architecture.
		assert.deepEqual(ui.prompts[1]!.detail, [KEEP, 'Yes, discard it and architect "Other"']);
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

	it("reset discards the architecture after a confirmation that starts on No", async () => {
		const ui = new FakeUi({ select: [KEEP, "Yes, discard it"] });
		const h = harness({ ui });
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "reset");
		assert.equal(ui.notifications[0]!.message, "There is no architecture to discard.");
		await h.command("architect", "Dedupe");
		await h.command("architect", "reset");
		assert.equal(rebuild(h.branch).architecture!.feature, "Dedupe");
		await h.command("architect", "reset");
		assert.equal(rebuild(h.branch).architecture!.feature, "");
		assert.equal(ui.prompts[1]!.title, 'Discard the architecture?\nThis discards the architecture for "Dedupe".');
		assert.deepEqual(ui.prompts[1]!.detail, [KEEP, "Yes, discard it"]);
	});
});

describe("read-only mode", () => {
	it("blocks writes only in architect mode", async () => {
		const h = harness({ ui: new FakeUi() });
		await h.fire("session_start", { reason: "startup" });
		assert.equal(await h.toolCall("bash", { command: "rm -rf x" }), undefined);
		await h.command("architect");
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
		await h.command("architect", "build");
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
		await h.command("architect", "build");
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

describe("tools per phase", () => {
	const architectTools = (h: ReturnType<typeof harness>) => h.active().filter((n) => n.startsWith("architect_"));
	const ev = (data: Record<string, unknown>) => ({ type: "custom", customType: ENTRY_TYPE, data: { v: 1, ...data } });
	const upTo = (phases: string[]) => [
		ev({ type: "begin", feature: "Dedupe", slug: "dedupe", at: 1 }),
		ev({ type: "mode", mode: "architect", at: 1 }),
		...phases.map((phase) => ev({ type: "verdict", phase, verdict: "approved", at: 2 })),
	];

	it("turns on only the tools of the current phase when a session loads", async () => {
		const phases = ["frame", "explore", "decide", "design", "slice", "blueprint"];
		const expected = [
			["architect_update", "architect_advance"],
			["architect_update", "architect_advance", "architect_diagram"],
			["architect_update", "architect_advance", "architect_decide", "architect_diagram"],
			["architect_update", "architect_advance", "architect_diagram"],
			["architect_update", "architect_advance", "architect_diagram", "architect_slice"],
			["architect_update", "architect_advance", "architect_diagram", "architect_slice"],
			["architect_update", "architect_advance"],
		];
		for (const [i, tools] of expected.entries()) {
			const h = harness({ ui: new FakeUi(), branch: upTo(phases.slice(0, i)) });
			await h.fire("session_start", { reason: "resume" });
			assert.deepEqual(architectTools(h), tools, phases[i] ?? "approved");
		}
	});

	it("switches the tools as soon as a phase is approved, in the middle of a run", async () => {
		const ui = new FakeUi().keys([KEYS.enter], [KEYS.enter]);
		const h = await architecting(ui);
		assert.deepEqual(architectTools(h), ["architect_update", "architect_advance"]);
		await h.call("architect_update", { feature: "Dedupe", brief: { goal: "g", done_when: ["d"] } });
		await h.call("architect_advance", {});
		assert.deepEqual(architectTools(h), ["architect_update", "architect_advance", "architect_diagram"]);
		await h.call("architect_update", { modules: [{ path: "src", role: "touched" }] });
		await h.call("architect_advance", {});
		assert.ok(architectTools(h).includes("architect_decide"));
		assert.ok(!h.active().includes("edit"));
	});

	it("does not touch the tools for content that leaves the phase as it is", async () => {
		const h = await architecting();
		const changes = h.activeHistory.length;
		await h.call("architect_update", { feature: "Dedupe", risks: [{ text: "ordering" }] });
		assert.equal(h.activeHistory.length, changes);
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
		const ui = new FakeUi().keys([KEYS.enter]);
		const h = await architecting(ui);
		await h.call("architect_update", { feature: "Dedupe", brief: { goal: "g", done_when: ["d"] } });
		const result = await h.call("architect_advance", { summary: "Check the scope" });
		assert.match(result.content[0]!.text, /^Frame approved\. Now in Explore \(phase 2\/6\):\n- Read the code/);
		const screen = ui.customs[0]!.frames[0]!.join("\n");
		assert.match(screen, /◆ Review Frame 1\/6/);
		assert.match(screen, /▍ Check the scope/);
		assert.match(screen, /GOAL\s+│\n│\s+g\s/);
		assert.deepEqual(ui.customs[0]!.options, { blocked: { kind: "question", message: "Review Frame" } });
		assert.deepEqual(events(h).slice(-2), ["submit", "verdict"]);
		assert.equal(ui.statuses.get(STATUS_KEY), "◆ architect · Explore");
	});

	it("requested changes return the user's comment", async () => {
		const ui = new FakeUi().keys(["r", ...type("  tighten the scope "), KEYS.enter]);
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
		const ui = new FakeUi().keys([KEYS.escape, KEYS.enter]);
		const h = await architecting(ui);
		await h.call("architect_update", { feature: "Dedupe", brief: { goal: "g", done_when: ["d"] } });
		const result = await h.call("architect_advance", {});
		assert.equal(result.terminate, true);
		assert.equal(result.details?.outcome, "closed");
		assert.match(result.content[0]!.text, /The user closed the Frame review without a decision/);
		assert.equal(rebuild(h.branch).architecture!.status, "working");
		assert.equal(ui.notifications.at(-1)!.message, "Frame review closed. /architect review opens it again.");
	});

	it("/architect review opens a closed review again, with the agent's summary, and tells the agent the verdict", async () => {
		const ui = new FakeUi().keys([KEYS.escape, KEYS.enter], [KEYS.enter]);
		const h = await architecting(ui);
		await h.call("architect_update", { feature: "Dedupe", brief: { goal: "g", done_when: ["d"] } });
		await h.call("architect_advance", { summary: "Check the goal." });
		ui.script({ select: ["Review this phase"] });
		await h.command("architect");
		assert.ok(
			ui.customs[1]!.frames[0]!.some((l) => l.includes("Check the goal.")),
			"the same summary",
		);
		assert.equal(rebuild(h.branch).architecture!.phase, "explore");
		const sent = h.sent.at(-1)!;
		assert.equal(sent.message.customType, REVIEW_MESSAGE);
		assert.match(
			String(sent.message.content),
			/^The user opened the Frame review again with \/architect review\.\nFrame approved\./,
		);
		assert.deepEqual(sent.options, { triggerTurn: true });
	});

	it("/architect review forgets the summary of a review closed before a reset or a branch change", async () => {
		const frame = { feature: "Dedupe", brief: { goal: "g", done_when: ["d"] } };
		for (const change of ["reset", "tree"] as const) {
			const ui = new FakeUi().keys([KEYS.escape, KEYS.enter], [KEYS.escape, KEYS.enter]);
			const h = await architecting(ui);
			await h.call("architect_update", frame);
			await h.call("architect_advance", { summary: "Check the goal." });
			if (change === "reset") {
				ui.script({ select: ["Yes, discard it"] });
				await h.command("architect", "reset");
				await h.call("architect_update", frame);
			} else await h.fire("session_tree", {});
			await h.command("architect", "review");
			assert.equal(ui.customs.length, 2, change);
			assert.ok(!ui.customs[1]!.frames[0]!.some((l) => l.includes("Check the goal.")), change);
		}
	});

	it("/architect review says why there is nothing to open", async () => {
		const ui = new FakeUi();
		const h = await architecting(ui);
		ui.script({ select: [undefined] });
		await h.command("architect");
		assert.ok(!(ui.prompts[0]!.detail as string[]).includes("Review this phase"), "not offered while incomplete");
		await h.command("architect", "review");
		assert.match(ui.notifications.at(-1)!.message, /^Frame is not ready for review yet\. It still needs /);
		await h.command("architect", "build");
		await h.command("architect", "review");
		assert.equal(
			ui.notifications.at(-1)!.message,
			"There is no phase to review. /architect <feature> starts an architecture.",
		);
		assert.deepEqual(ui.customs, []);
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
		const ui = new FakeUi().keys([KEYS.enter]);
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
		assert.deepEqual(done.render(60), [], "the verdict's banner says it, once");
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

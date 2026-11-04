import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { ENTRY_TYPE, PLAN_DIR_FLAG, WIDGET_KEY, type ArchitectOverrides } from "../src/index.ts";
import { SECTION } from "../src/prompt.ts";
import { event, type EventInput } from "../src/state/events.ts";
import { rebuild, reduce, INITIAL_STATE } from "../src/state/reducer.ts";
import { harness, type BranchEntry } from "./harness.ts";
import { FakeUi, plainTheme } from "./helpers.ts";

const SLICE = {
	id: "s1",
	title: "Store the key",
	goal: "Events carry a key.",
	files: ["src/key.ts"],
	steps: ["Add dedupKey() to src/key.ts", "Call dedupKey() from src/ingest.ts"],
	verify: ["npm test"],
};

const entry = (input: EventInput): BranchEntry => ({ type: "custom", customType: ENTRY_TYPE, data: event(input) });

/** A branch with an approved architecture and no plan file yet. */
function approvedBranch(): BranchEntry[] {
	return [
		entry({ type: "mode", mode: "architect", at: 1 }),
		entry({ type: "begin", feature: "Dedupe", slug: "dedupe", at: 1 }),
		entry({ type: "update", phase: "frame", brief: { goal: "One event per incident.", doneWhen: ["npm test"] } }),
		entry({
			type: "slices",
			replace: true,
			slices: [{ ...SLICE, dependsOn: [] }],
		}),
		...(["frame", "explore", "decide", "design", "slice", "blueprint"] as const).map((phase) =>
			entry({ type: "verdict", phase, verdict: "approved", at: 2 }),
		),
	];
}

async function approved(
	options: { ui?: FakeUi; overrides?: ArchitectOverrides; cwd?: string; mode?: "tui" | "rpc" } = {},
) {
	const h = harness({ ui: options.ui ?? new FakeUi(), branch: approvedBranch(), ...options });
	await h.fire("session_start", { reason: "resume" });
	return h;
}

const planPath = join("docs", "plans", "dedupe.md");

describe("writing the plan on Blueprint approval", () => {
	it("walks every phase, writes the plan file and records where", async () => {
		const h = harness({
			ui: new FakeUi(),
			overrides: { review: async () => ({ verdict: "approved" }) },
			builtins: ["read", "bash"],
		});
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "Dedupe");
		await h.call("architect_update", { brief: { goal: "g", done_when: ["d"] } });
		await h.call("architect_advance", {});
		await h.call("architect_update", { modules: [{ path: "src/ingest", role: "touched" }] });
		await h.call("architect_advance", {});
		await h.call("architect_advance", {});
		await h.call("architect_diagram", { title: "Flow", body: "A ──▶ B" });
		await h.call("architect_advance", {});
		const notReady = await h.call("architect_advance", {});
		assert.equal(notReady.details?.outcome, "not-ready");
		const sliced = await h.call("architect_slice", { slices: [SLICE] });
		assert.match(
			sliced.content[0]!.text,
			/^Saved 1 slice\. Build order: 1\. s1\. Check: Not in the module map, so the plan lists it as new: src\/key\.ts\. .* Slice is ready/,
		);
		await h.call("architect_advance", {});
		const final = await h.call("architect_advance", {});
		assert.equal(final.details?.planPath, planPath);
		assert.match(
			final.content[0]!.text,
			/It is saved at docs\/plans\/dedupe\.md\. Tell the user they can build it with \/architect plan/,
		);
		const text = readFileSync(join(h.cwd, planPath), "utf8");
		assert.match(text, /^---\nfeature: "Dedupe"\nslug: "dedupe"\nstatus: approved\n/);
		assert.match(text, /^session: "test-session"$/m);
		assert.deepEqual(rebuild(h.branch).plan, {
			path: planPath,
			feature: "Dedupe",
			slug: "dedupe",
			at: rebuild(h.branch).plan!.at,
		});
		await assert.rejects(h.call("architect_slice", { slices: [SLICE] }), /approved and final/);
	});

	it("does not overwrite an existing plan file", async () => {
		const ui = new FakeUi({ confirm: [true] });
		const h = harness({ ui, branch: approvedBranch() });
		mkdirSync(join(h.cwd, "docs", "plans"), { recursive: true });
		writeFileSync(join(h.cwd, planPath), "someone else's plan");
		await h.fire("session_start", { reason: "resume" });
		await h.command("architect", "plan");
		assert.equal(readFileSync(join(h.cwd, planPath), "utf8"), "someone else's plan");
		assert.equal(rebuild(h.branch).plan!.path, join("docs", "plans", "dedupe-2.md"));
		assert.deepEqual(ui.notifications.at(-1), {
			message: `Plan written to ${join("docs", "plans", "dedupe-2.md")}`,
			type: "info",
		});
	});

	it("writes to the configured directory: overrides first, then the flag", async () => {
		const flagged = harness({
			ui: new FakeUi(),
			branch: approvedBranch(),
			flags: { [PLAN_DIR_FLAG]: " plans " } as never,
		});
		await flagged.fire("session_start", { reason: "resume" });
		await flagged.command("architect", "plan write");
		assert.equal(rebuild(flagged.branch).plan!.path, join("plans", "dedupe.md"));

		// A fresh directory, so earlier runs cannot fill it up with dedupe-2.md … dedupe-100.md.
		const dir = mkdtempSync(join(tmpdir(), "pi-architect-plans-"));
		const h = await approved({ overrides: { planDir: join(dir, "..", basename(dir)) } });
		await h.command("architect", "plan write");
		assert.equal(rebuild(h.branch).plan!.path, join(dir, "dedupe.md"));
		assert.ok(h.flags[PLAN_DIR_FLAG]);
	});

	it("reports a failed write to the model and the user without failing the approval", async () => {
		const h = harness({
			ui: new FakeUi(),
			branch: approvedBranch().slice(0, -1),
			overrides: { review: async () => ({ verdict: "approved" }), planDir: "blocked" },
		});
		writeFileSync(join(h.cwd, "blocked"), "a file, not a directory");
		await h.fire("session_start", { reason: "resume" });
		const final = await h.call("architect_advance", {});
		assert.equal(final.details?.final, true);
		assert.equal(final.details?.planPath, undefined);
		assert.match(
			final.content[0]!.text,
			/Writing the plan file failed: .*\. The user can retry with \/architect plan write\./,
		);
		assert.equal(rebuild(h.branch).plan, undefined);
		await h.command("architect", "plan write");
		assert.match(h.ui!.notifications.at(-1)!.message, /^Writing the plan file failed: /);
	});

	it("keeps architect mode read-only after the plan is written, also for the plan file", async () => {
		const h = await approved();
		await h.command("architect", "plan write");
		const file = join(h.cwd, planPath);
		for (const [tool, input] of [
			["write", { path: file, content: "x" }],
			["edit", { path: file, edits: [] }],
			["write", { path: join(h.cwd, "other.md"), content: "x" }],
			["bash", { command: `echo x > ${file}` }],
		] as const)
			assert.ok((await h.toolCall(tool, input))?.block, `${tool} is blocked`);
		assert.equal(await h.toolCall("read", { path: file }), undefined);
	});

	it("shows the plan in the transcript", async () => {
		const h = harness();
		const line = (
			h.entryRenderers[ENTRY_TYPE]!(
				{ data: event({ type: "plan", path: "docs/plans/x.md", feature: "X", slug: "x", at: 1 }) },
				{},
				plainTheme,
			) as { render(w: number): string[] }
		).render(80);
		assert.equal(line[0]!.trimEnd(), "▣ plan docs/plans/x.md  /architect plan to build it");
	});
});

describe("plan state", () => {
	const plan = (input: Record<string, unknown>) => ({ v: 1, type: "plan", ...input }) as never;

	it("records a valid plan event, in any mode and after approval", () => {
		const state = rebuild(approvedBranch());
		const next = reduce(state, plan({ path: " docs/a.md ", feature: "A", slug: "a", at: 3 }));
		assert.deepEqual(next.plan, { path: "docs/a.md", feature: "A", slug: "a", at: 3 });
		assert.deepEqual(reduce(INITIAL_STATE, plan({ path: "p", slug: "s", at: 1 })).plan, {
			path: "p",
			feature: "",
			slug: "s",
			at: 1,
		});
	});

	it("ignores a damaged plan event", () => {
		for (const bad of [
			{ path: "", slug: "s", at: 1 },
			{ path: 3, slug: "s", at: 1 },
			{ path: "p", at: 1 },
			{ path: "p", slug: "s" },
		])
			assert.equal(reduce(INITIAL_STATE, plan(bad)), INITIAL_STATE);
	});

	it("a new architecture or a reset keeps the plan, whose file is still there to build", () => {
		const withPlan = reduce(rebuild(approvedBranch()), plan({ path: "p", slug: "s", at: 1 }));
		const begun = reduce(withPlan, event({ type: "begin", feature: "B", slug: "b", at: 4 }));
		assert.equal(begun.plan!.path, "p");
		assert.equal(begun.architecture!.feature, "B");
		const reset = reduce(withPlan, event({ type: "reset", at: 4 }));
		assert.equal(reset.plan!.path, "p");
		assert.equal(reset.architecture!.approvedAt, undefined);
		const build = reduce(withPlan, event({ type: "mode", mode: "build", at: 4 }));
		const buildReset = reduce(build, event({ type: "reset", at: 5 }));
		assert.equal(buildReset.architecture, undefined);
		assert.equal(buildReset.plan!.path, "p");
	});
});

describe("build mode progress", () => {
	async function building() {
		const ui = new FakeUi();
		const h = await approved({ ui });
		await h.command("architect", "plan write");
		await h.command("architect", "build");
		return { h, ui, file: join(h.cwd, planPath) };
	}

	const tick = (file: string, count: number) => {
		let text = readFileSync(file, "utf8");
		for (let i = 0; i < count; i++) text = text.replace(/^- \[ \]/m, "- [x]");
		writeFileSync(file, text);
	};

	it("shows the plan's slices from the file", async () => {
		const { ui } = await building();
		assert.deepEqual(ui.widgetLines(WIDGET_KEY, 80), [
			" ▸ BUILD  plan: dedupe  ●1   slice 1/1 · Store the key          ctrl+alt+b board",
		]);
		assert.deepEqual(ui.widgetLines(WIDGET_KEY, 30), [" ▸ BUILD  ●1   slice 1/1"]);
	});

	it("updates when the builder edits the plan file", async () => {
		const { h, ui, file } = await building();
		const renders = ui.renders;
		tick(file, 3);
		await h.fire("tool_result", { toolName: "edit", input: { path: join(h.cwd, "src/other.ts") }, isError: false });
		assert.match(ui.widgetLines(WIDGET_KEY, 80)![0]!, /●1/, "another file does not re-read the plan");
		await h.fire("tool_result", { toolName: "edit", input: { path: planPath }, isError: true });
		assert.match(ui.widgetLines(WIDGET_KEY, 80)![0]!, /●1/, "a failed edit does not re-read the plan");
		await h.fire("tool_result", { toolName: "edit", input: { path: `@${planPath}` }, isError: false });
		assert.deepEqual(ui.widgetLines(WIDGET_KEY, 80), [
			" ▸ BUILD  plan: dedupe  ✓1   all 1 slice done                   ctrl+alt+b board",
		]);
		assert.ok(ui.renders > renders);
	});

	it("re-reads after bash and after each run", async () => {
		const { h, ui, file } = await building();
		tick(file, 3);
		await h.fire("tool_result", { toolName: "bash", input: { command: "sed -i s/x/y/ plan.md" }, isError: false });
		assert.match(ui.widgetLines(WIDGET_KEY, 80)![0]!, /all 1 slice done/);
		writeFileSync(file, readFileSync(file, "utf8").replace(/^- \[x\]/m, "- [ ]"));
		await h.fire("agent_end", {});
		assert.match(ui.widgetLines(WIDGET_KEY, 80)![0]!, /●1/);
		const renders = ui.renders;
		await h.fire("agent_end", {});
		assert.equal(ui.renders, renders, "no redraw when nothing changed");
	});

	it("tells the model where the plan is until it is done", async () => {
		const { h, file } = await building();
		const run = await h.startRun();
		assert.match(run.sections[SECTION]!, /approved a plan for "Dedupe" at docs\/plans\/dedupe\.md/);
		tick(file, 3);
		await h.fire("agent_end", {});
		assert.equal((await h.startRun()).sections[SECTION], undefined);
	});

	it("says when the plan file is missing, or was never written", async () => {
		const { h, ui, file } = await building();
		writeFileSync(file, "");
		await h.fire("agent_end", {});
		assert.deepEqual(ui.widgetLines(WIDGET_KEY, 80), [
			" ▸ BUILD  plan: dedupe  no slices                               ctrl+alt+b board",
		]);
		const { rmSync } = await import("node:fs");
		rmSync(file);
		await h.fire("agent_end", {});
		assert.deepEqual(ui.widgetLines(WIDGET_KEY, 80), [
			" ▸ BUILD  plan: dedupe  ●1   plan file not found · /architect plan",
		]);

		const unwritten = await approved();
		await unwritten.command("architect", "build");
		assert.deepEqual(unwritten.ui!.widgetLines(WIDGET_KEY, 80), [
			" ▸ BUILD  plan: dedupe  ●1   plan not written · /architect plan write",
		]);
	});

	it("gives RPC clients the progress as plain lines", async () => {
		const ui = new FakeUi();
		const h = await approved({ ui, mode: "rpc" });
		await h.command("architect", "plan write");
		await h.command("architect", "build");
		assert.deepEqual(ui.widgets.get(WIDGET_KEY), [" ▸ BUILD  plan: dedupe  ●1   slice 1/1 · Store the key"]);
	});
});

describe("/architect plan", () => {
	it("completes its actions after /architect plan", () => {
		const h = harness();
		const items = h.commands.architect!.getArgumentCompletions!("plan ") as { value: string }[];
		assert.deepEqual(
			items.map((i) => i.value),
			["plan open", "plan write", "plan build"],
		);
		assert.equal(h.commands.architect!.getArgumentCompletions!("plan zz"), null);
	});

	it("explains that there is no plan, or offers to write an approved one", async () => {
		const ui = new FakeUi({ confirm: [false] });
		const none = harness({ ui });
		await none.fire("session_start", { reason: "startup" });
		await none.command("architect", "plan");
		assert.match(ui.notifications.at(-1)!.message, /no approved plan in this session/);
		const h = await approved({ ui });
		await h.command("architect", "plan");
		assert.equal(rebuild(h.branch).plan, undefined, "declined");
		const headless = harness({ branch: approvedBranch() });
		await headless.fire("session_start", { reason: "resume" });
		await headless.command("architect", "plan");
		assert.equal(rebuild(headless.branch).plan, undefined);
		await headless.command("architect", "plan write");
		assert.equal(rebuild(headless.branch).plan!.path, planPath);
		await headless.command("architect", "plan");
	});

	it("rejects an unknown action", async () => {
		const h = await approved();
		for (const action of ["nope", "here", "copy", "path"]) {
			await h.command("architect", `plan ${action}`);
			assert.equal(
				h.ui!.notifications.at(-1)!.message,
				`Unknown /architect plan action "${action}". Use open, write or build.`,
			);
		}
	});

	it("shows the path and progress, copies and opens", async () => {
		const copied: string[] = [];
		const opened: string[] = [];
		const ui = new FakeUi({ select: ["Copy the path"] });
		const h = await approved({
			ui,
			overrides: {
				copy: async (text) => {
					copied.push(text);
				},
				open: async (file) => {
					opened.push(file);
				},
			},
		});
		await h.command("architect", "plan write");
		await h.command("architect", "plan");
		assert.equal(ui.prompts.at(-1)!.title, `Plan: ${planPath} · 0/1 slices done`);
		assert.deepEqual(copied, [planPath]);
		assert.equal(ui.notifications.at(-1)!.message, `Copied ${planPath}`);
		await h.command("architect", "plan open");
		assert.deepEqual(opened, [join(h.cwd, planPath)]);
		await h.command("architect", "plan write");
		assert.equal(h.ui!.notifications.at(-1)!.message, `The plan file is already at ${planPath}.`);
	});

	it("opens with the system opener and says when that fails", async () => {
		const h = harness({ ui: new FakeUi(), branch: approvedBranch(), execCode: 1 });
		await h.fire("session_start", { reason: "resume" });
		await h.command("architect", "plan write");
		await h.command("architect", "plan open");
		assert.equal(h.execs.length, 1);
		assert.ok(h.execs[0]!.args.includes(join(h.cwd, planPath)));
		assert.match(h.ui!.notifications.at(-1)!.message, /^Could not open docs\/plans\/dedupe\.md/);
	});

	it("offers the actions in a menu", async () => {
		const ui = new FakeUi({ select: ["Copy the path", undefined] });
		const copied: string[] = [];
		const h = await approved({ ui, overrides: { copy: async (t) => void copied.push(t) } });
		await h.command("architect", "plan write");
		await h.command("architect", "plan");
		assert.deepEqual(copied, [planPath]);
		assert.equal(ui.prompts.at(-1)!.title, `Plan: ${planPath} · 0/1 slices done`);
		assert.deepEqual(ui.prompts.at(-1)!.detail, [
			"Build it in a new session",
			"Build it here, in build mode",
			"Copy the path",
			"Open the file",
		]);
		await h.command("architect", "plan");
		assert.ok(ui.done);
	});

	it("offers to write the file again when it is missing, and refuses to build from nothing", async () => {
		const ui = new FakeUi();
		const h = await approved({ ui });
		await h.command("architect", "plan write");
		const { rmSync } = await import("node:fs");
		rmSync(join(h.cwd, planPath));
		ui.script({ select: ["Build it here, in build mode"] });
		for (const action of ["build", "", "open"]) {
			await h.command("architect", `plan ${action}`);
			assert.equal(
				ui.notifications.at(-1)!.message,
				`The plan file ${planPath} is missing. Run /architect plan write to write it again.`,
			);
		}
		ui.script({ select: ["Write the file again"] });
		await h.command("architect", "plan");
		assert.equal(readFileSync(join(h.cwd, planPath), "utf8").startsWith("---"), true);
	});

	it("builds here: switches to build mode and sends the kickoff", async () => {
		const ui = new FakeUi({ select: ["Build it here, in build mode", "Build it here, in build mode"] });
		const h = await approved({ ui });
		await h.command("architect", "plan write");
		await h.command("architect", "plan");
		assert.equal(rebuild(h.branch).mode, "build");
		assert.deepEqual(h.userMessages, [
			{
				content: `Build the plan at ${planPath}. Read the whole file first, then follow its "How to build this plan" section.`,
				options: undefined,
			},
		]);
		(h.ctx as { isIdle: () => boolean }).isIdle = () => false;
		await h.command("architect", "plan");
		assert.deepEqual(h.userMessages[1]!.options, { deliverAs: "followUp" });
	});

	it("does not build here when the user stays in architect mode", async () => {
		const ui = new FakeUi({ select: ["Build it here, in build mode"], confirm: [false] });
		const h = harness({ ui, branch: [...approvedBranch().slice(0, -1)] });
		await h.fire("session_start", { reason: "resume" });
		h.branch.push(entry({ type: "plan", path: planPath, feature: "Dedupe", slug: "dedupe", at: 3 }));
		mkdirSync(join(h.cwd, "docs", "plans"), { recursive: true });
		writeFileSync(join(h.cwd, planPath), "## Slices\n\n### 1. a\n\n- [ ] x\n");
		await h.fire("session_tree", {});
		await h.command("architect", "plan");
		assert.equal(rebuild(h.branch).mode, "architect");
		assert.deepEqual(h.userMessages, []);
	});

	it("hands the plan to a new build session that shows the progress", async () => {
		const h = await approved();
		await h.command("architect", "plan write");
		await h.command("architect", "plan build");
		const [opts] = h.newSessions;
		assert.equal(opts!.parentSession, "/sessions/test.jsonl");
		const appended: BranchEntry[] = [];
		await opts!.setup!({
			appendCustomEntry: (customType, data) => void appended.push({ type: "custom", customType, data }),
		});
		const sentToNew: string[] = [];
		await opts!.withSession!({ sendUserMessage: async (text) => void sentToNew.push(text) });
		assert.match(sentToNew[0]!, /^Build the plan at docs\/plans\/dedupe\.md\./);

		const ui = new FakeUi();
		const next = harness({ ui, cwd: h.cwd, branch: appended });
		await next.fire("session_start", { reason: "new" });
		assert.equal(rebuild(next.branch).mode, "build");
		assert.deepEqual(ui.widgetLines(WIDGET_KEY, 80), [
			" ▸ BUILD  plan: dedupe  ●1   slice 1/1 · Store the key          ctrl+alt+b board",
		]);
		assert.match((await next.startRun()).sections[SECTION]!, /docs\/plans\/dedupe\.md/);
		await next.command("architect", "plan write");
		assert.equal(ui.notifications.at(-1)!.message, `The plan file is already at ${planPath}.`);
		const { rmSync } = await import("node:fs");
		rmSync(join(h.cwd, planPath));
		await next.command("architect", "plan write");
		assert.equal(
			ui.notifications.at(-1)!.message,
			"This session cannot write the plan: the design is in another session.",
		);
		await next.command("architect", "plan build");
		assert.equal(ui.notifications.at(-1)!.message, `The plan file ${planPath} is missing.`);
		assert.deepEqual(ui.widgetLines(WIDGET_KEY, 80), [
			" ▸ BUILD  plan: dedupe  plan file not found · /architect plan   ctrl+alt+b board",
		]);
	});

	it("says when the new session was cancelled", async () => {
		const h = harness({ ui: new FakeUi(), branch: approvedBranch(), cancelNewSession: true });
		await h.fire("session_start", { reason: "resume" });
		await h.command("architect", "plan write");
		await h.command("architect", "plan build");
		assert.equal(h.ui!.notifications.at(-1)!.message, "The new session was cancelled.");
		const headless = harness({ branch: approvedBranch(), cancelNewSession: true });
		await headless.fire("session_start", { reason: "resume" });
		await headless.command("architect", "plan build");
	});
});

describe("architect_slice", () => {
	it("only works in architect mode, and renders its call and result", async () => {
		const h = harness({ ui: new FakeUi() });
		await h.fire("session_start", { reason: "startup" });
		await assert.rejects(h.call("architect_slice", { slices: [SLICE] }), /only works in architect mode/);
		const tool = h.tools.architect_slice!;
		const ctx = { lastComponent: undefined, isError: false };
		assert.equal(
			tool.renderCall!({ slices: [SLICE] }, plainTheme, ctx)
				.render(80)[0]!
				.trimEnd(),
			"◆ architect slice  1 slice",
		);
		const details = {
			phase: "slice",
			groups: [["s1"]],
			titles: { s1: "t" },
			added: [],
			changed: [],
			removed: [],
			missing: [],
		};
		assert.deepEqual(
			tool.renderResult!(
				{ content: [{ type: "text", text: "" }], details },
				{ expanded: false, isPartial: false },
				plainTheme,
				ctx,
			)
				.render(80)
				.map((l) => l.trimEnd()),
			["✓ 1 slice in 1 step · Slice ready for review", "  step 1  1"],
		);
		const component = tool.renderResult!(
			{ content: [{ type: "text", text: "bad" }], details: undefined },
			{ expanded: false, isPartial: false },
			plainTheme,
			{ lastComponent: undefined, isError: true },
		);
		assert.equal(component.render(80)[0]!.trimEnd(), "✗ bad");
	});
});

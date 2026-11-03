import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { format } from "prettier";
import { buildBlueprint } from "../src/plan/blueprint.ts";
import { buildSection, kickoff } from "../src/plan/handoff.ts";
import { isDone, parsePlanProgress, sliceStates } from "../src/plan/progress.ts";
import { renderPlan } from "../src/plan/render.ts";
import { displayPath, nextPlanPath, planFile, readPlan, writePlan } from "../src/plan/write.ts";
import { newArchitecture } from "../src/state/reducer.ts";
import type { Architecture } from "../src/state/types.ts";
import { fullArchitecture } from "./fixtures/plan/architecture.ts";

const SNAPSHOT = new URL("./fixtures/plan/dedupe-panel-events.md", import.meta.url);
const SESSION = "01a1a1cb-cb27-747e-9beb-a4bec3b9f2fe";

/** Prettier with the repository's markdown options. */
const pretty = (md: string) => format(md, { parser: "markdown", useTabs: false, tabWidth: 2, printWidth: 120 });

const tmp = () => mkdtemp(join(tmpdir(), "pi-architect-plan-"));

describe("renderPlan", () => {
	it("matches the snapshot for a full architecture", async () => {
		const md = renderPlan(fullArchitecture(), { session: SESSION });
		if (process.env.UPDATE_SNAPSHOTS) await writeFile(SNAPSHOT, md);
		assert.equal(md, await readFile(SNAPSHOT, "utf8"));
	});

	it("is deterministic and stable under prettier", async () => {
		const md = renderPlan(fullArchitecture(), { session: SESSION });
		assert.equal(renderPlan(fullArchitecture(), { session: SESSION }), md);
		assert.equal(await pretty(md), md);
	});

	it("keeps its structure and stays prettier-stable whatever the agent wrote", async () => {
		const nasty = [
			"# not a heading",
			"- not a list",
			"1. not ordered",
			"> not a quote",
			"* star",
			"+ plus",
			"[ ] box",
			"---",
			"***",
			"===",
			"a  *b*  _c_ \n d **e**",
			"Map<string, Event> and a|b",
			"snake_case_name and __init__ and `__init__`",
			"use `code` and ``x`y`` and `*star*`",
			"2 * 3 = 6 and 100% & more",
			"a [link](x) and [ref]",
		];
		const arch = fullArchitecture();
		arch.feature = "Weird: feature # name";
		arch.brief.goal = nasty.join(" ");
		arch.brief.constraints = nasty;
		arch.findings = nasty.map((text, i) => ({ id: `f${i}`, text }));
		arch.modules[0]!.files.push("weird`name.ts", "`start.ts", "__init__.py");
		arch.diagrams[1]!.body = "\n```\ninside\n```\n  trailing   \r\n\n";
		arch.diagrams[1]!.caption = "# caption";
		arch.decisions[0]!.comment = "line one\nline two > three";
		arch.slices[0]!.steps = nasty.map((s) => `${s} step here`);
		arch.slices[0]!.verify = ["echo '```'", "npm test"];
		const md = renderPlan(arch);
		assert.equal(await pretty(md), md);
		assert.match(md, /^- \\# not a heading$/m);
		assert.match(md, /^- \\---$/m);
		assert.match(md, /^ {2}- `__init__.py`$/m, "code keeps its underscores");
		assert.match(md, /and \*\*init\*\* and `__init__`/, "emphasis outside code is written like prettier");
		assert.match(md, /^````text\n```\ninside\n```\n {2}trailing\n````$/m, "a longer fence around backticks");
		assert.match(md, /^````bash\necho '```'\nnpm test\n````$/m);
		assert.match(md, /^feature: "Weird: feature # name"$/m, "front matter values are quoted");
		assert.deepEqual(
			parsePlanProgress(md).map((s) => s.total),
			[nasty.length + 1, 4, 2, 4],
			"boxes inside code do not count",
		);
	});

	it("renders a draft with an open decision and empty sections", async () => {
		const arch: Architecture = {
			...newArchitecture(1, "", ""),
			decisions: [
				{
					id: "q1",
					question: "Which one?",
					options: [{ id: "A", title: "a", pros: [], cons: [], effort: 1, risk: 1 }],
				},
			],
			slices: [{ id: "s1", title: "Only", dependsOn: ["gone"], files: [], steps: [], verify: [] }],
		};
		const md = renderPlan(arch);
		assert.equal(await pretty(md), md);
		assert.match(md, /^feature: "feature"\nslug: "feature"\nstatus: draft\nslices: 1\ngenerator: pi-architect\n---$/m);
		assert.match(md, /^# Feature$/m);
		assert.match(md, /### Goal\n\nNot set\.\n\n### Constraints\n\nNone\./);
		assert.match(md, /### Modules\n\nNone\./);
		assert.doesNotMatch(md, /### Current shape/);
		assert.match(md, /### 1\. Which one\?\n\n\*\*Open\.\*\* This question was not decided/);
		assert.match(md, /## Design\n\nNo diagrams\./);
		assert.match(md, /## Risks\n\nNone known\./);
		assert.match(
			md,
			/\*\*Depends on:\*\* nothing\n\n\*\*Files:\*\*\n\nNone listed\.\n\n\*\*Steps:\*\*\n\nNone listed\./,
		);
		assert.match(md, /No commands given\. Ask the user how to verify it\./);
		assert.doesNotMatch(md, /\*\*Goal:\*\*/);

		const bare = renderPlan({ ...newArchitecture(1, "Bare", "bare"), decisions: [], slices: [] });
		assert.match(bare, /## Decisions\n\nNo open questions came up\./);
		assert.match(bare, /## Slices\n\nNo slices\.\n$/);
		assert.match(renderPlan({ ...newArchitecture(1, "", "only-slug") }), /^feature: "only-slug"$/m);
	});

	it("explains rejected options without cons, and options without pros or cons", () => {
		const arch = fullArchitecture();
		arch.decisions[0]!.options[2]!.cons = [];
		arch.decisions[0]!.options[0]!.pros = [];
		arch.decisions[0]!.options[0]!.cons = [];
		const md = renderPlan(arch);
		assert.match(md, /- \*\*C\. Redis stream\*\*: Not chosen\.$/m);
		assert.match(md, /\*\*Chosen: A\. In the processor\*\* \(recommended\)\n\nSkip an event[^\n]*\n\nEffort 2\/5/);
	});
});

describe("an option the user wrote", () => {
	/** The fixture, with the user's own option chosen for q1. Its effort and risk are only placeholders. */
	function withOwnOption(): Architecture {
		const arch = fullArchitecture();
		const q1 = arch.decisions[0]!;
		q1.options.push({
			id: "D",
			title: "At the panel gateway",
			summary: "The gateway drops repeats before the processor sees them.",
			pros: [],
			cons: [],
			effort: 3,
			risk: 3,
			byUser: true,
		});
		q1.chosen = "D";
		return arch;
	}

	it("has no rating in the blueprint", () => {
		const bp = buildBlueprint(withOwnOption());
		const chosen = bp.decisions[0]!.chosen!;
		assert.equal(chosen.byUser, true);
		assert.equal(chosen.rating, undefined);
		assert.ok(!("effort" in chosen) && !("risk" in chosen));
		assert.deepEqual(bp.decisions[0]!.rejected[0]!.option.rating, { effort: 2, risk: 1 });
		assert.equal(bp.decisions[0]!.rejected[0]!.option.byUser, false);
	});

	it("shows in the plan as the user's, never with placeholder ratings", async () => {
		const md = renderPlan(withOwnOption());
		const q1 = md.slice(md.indexOf("### 1."), md.indexOf("### 2."));
		assert.match(
			q1,
			/\*\*Chosen: D\. At the panel gateway\*\*\n\nThe gateway drops[^\n]*\n\nThe user wrote this option\. Nobody rated its effort or risk\./,
		);
		assert.doesNotMatch(q1, /Effort 3\/5|risk 3\/5/);
		assert.equal(await pretty(md), md);
	});
});

describe("buildBlueprint", () => {
	it("arranges the architecture as the plan", () => {
		const bp = buildBlueprint(fullArchitecture());
		assert.equal(bp.status, "approved");
		assert.deepEqual(
			bp.modules.map((m) => m.path),
			["src/ingest", "migrations", "src/ingest/dedup", "src/api/alarms"],
		);
		assert.deepEqual(
			bp.risks.map((r) => r.severity),
			["high", "medium", "low"],
		);
		assert.deepEqual(
			bp.currentShape.map((d) => d.id),
			["g1"],
		);
		assert.deepEqual(
			bp.design.map((d) => d.id),
			["g2", "g3"],
		);
		assert.deepEqual(
			bp.slices.map((o) => `${o.number}:${o.slice.id}`),
			["1:s1", "2:s2", "3:s3", "4:s4"],
		);
		const [d1, d2] = bp.decisions;
		assert.equal(d1!.chosen?.id, "A");
		assert.equal(d1!.followedRecommendation, true);
		assert.deepEqual(
			d1!.rejected.map((r) => r.option.id),
			["B", "C"],
		);
		assert.equal(d2!.followedRecommendation, false);
		const { effort, risk, ...forever } = fullArchitecture().decisions[1]!.options[0]!;
		assert.deepEqual(d2!.rejected, [
			{ option: { ...forever, rating: { effort, risk }, byUser: false }, recommended: true },
		]);
		assert.deepEqual(bp.counts, {
			modules: 4,
			findings: 3,
			decisions: 2,
			open: 0,
			diagrams: 3,
			risks: 3,
			highRisks: 1,
			slices: 4,
			steps: 3,
		});
	});

	it("marks a draft and an open decision", () => {
		const arch = { ...fullArchitecture() };
		delete arch.approvedAt;
		arch.decisions = [{ ...arch.decisions[0]!, chosen: undefined } as never];
		const bp = buildBlueprint(arch);
		assert.equal(bp.status, "draft");
		assert.equal(bp.approvedAt, undefined);
		assert.equal(bp.decisions[0]!.chosen, undefined);
		assert.equal(bp.decisions[0]!.followedRecommendation, false);
		assert.equal(bp.decisions[0]!.rejected.length, 3);
	});
});

describe("parsePlanProgress", () => {
	it("reads every slice of the snapshot, all unticked", async () => {
		const progress = parsePlanProgress(await readFile(SNAPSHOT, "utf8"));
		assert.deepEqual(
			progress.map((s) => [s.number, s.title, s.total, s.checked]),
			[
				[1, "Add the dedup key column", 3, 0],
				[2, "Store dedup key", 4, 0],
				[3, "Show skipped duplicates in the debug log", 2, 0],
				[4, "Skip duplicates on insert", 4, 0],
			],
		);
	});

	it("counts ticked boxes, only under ## Slices and outside code", () => {
		const md = [
			"## Brief",
			"- [x] not a slice box",
			"## Slices",
			"- [x] before any slice",
			"### 1. One ##",
			"- [x] a",
			"  * [X] b",
			"~~~",
			"- [ ] in code",
			"~~~",
			"````",
			"```",
			"- [ ] still code",
			"````",
			"### 2. Two",
			"- [ ] c",
			"+ [x] d",
			"## Later",
			"### 3. Not a slice",
			"- [ ] e",
		].join("\r\n");
		assert.deepEqual(parsePlanProgress(md), [
			{ number: 1, title: "One", total: 2, checked: 2 },
			{ number: 2, title: "Two", total: 2, checked: 1 },
		]);
		assert.deepEqual(parsePlanProgress("# nothing here"), []);
	});

	it("marks slices done, active or pending", () => {
		const s = (checked: number, total = 2) => ({ number: 1, title: "t", total, checked });
		assert.deepEqual(sliceStates([s(2), s(0), s(1), s(0)]), ["done", "active", "active", "pending"]);
		assert.deepEqual(sliceStates([s(2), s(2)]), ["done", "done"]);
		assert.equal(isDone(s(0, 0)), false);
	});
});

describe("writePlan", () => {
	it("creates the directory and writes <slug>.md", async () => {
		const dir = join(await tmp(), "docs", "plans");
		const file = await writePlan(dir, "dedupe", "one");
		assert.equal(file, resolve(dir, "dedupe.md"));
		assert.equal(await readFile(file, "utf8"), "one");
	});

	it("never overwrites: a taken name gets a numeric suffix", async () => {
		const dir = await tmp();
		await writeFile(join(dir, "dedupe.md"), "mine");
		assert.equal(await writePlan(dir, "dedupe", "two"), join(dir, "dedupe-2.md"));
		assert.equal(await writePlan(dir, "dedupe", "three"), join(dir, "dedupe-3.md"));
		assert.equal(await readFile(join(dir, "dedupe.md"), "utf8"), "mine");
		assert.equal(await readFile(join(dir, "dedupe-2.md"), "utf8"), "two");
	});

	it("predicts the path it will write to, with a taken name numbered the same way", async () => {
		const dir = await tmp();
		assert.equal(nextPlanPath(join(dir, "new"), "dedupe"), join(dir, "new", "dedupe.md"), "a missing directory");
		await writeFile(join(dir, "dedupe.md"), "mine");
		const predicted = nextPlanPath(dir, "dedupe");
		assert.equal(predicted, join(dir, "dedupe-2.md"));
		assert.equal(await writePlan(dir, "dedupe", "two"), predicted);
		assert.equal(nextPlanPath(dir, "dedupe"), join(dir, "dedupe-3.md"));
		await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(dir, i ? `x-${i + 1}.md` : "x.md"), "")));
		assert.equal(nextPlanPath(dir, "x"), undefined, "every name is taken");
	});

	it("gives up after 100 taken names and reports other errors", async () => {
		const dir = await tmp();
		await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(dir, i ? `x-${i + 1}.md` : "x.md"), "")));
		await assert.rejects(writePlan(dir, "x", "y"), /100 plan files named x already exist/);
		await writeFile(join(dir, "file"), "");
		await assert.rejects(writePlan(join(dir, "file"), "x", "y"), /EEXIST|ENOTDIR/);
		await mkdtemp(join(dir, "sub-"));
		await assert.rejects(writePlan(dir, "sub-/../file/x", "y"), /ENOTDIR|ENOENT/);
	});

	it("stores paths relative to the cwd when inside it", () => {
		assert.equal(displayPath("/p", "/p/docs/plans/a.md"), join("docs", "plans", "a.md"));
		assert.equal(displayPath("/p", "/elsewhere/a.md"), resolve("/elsewhere/a.md"));
		assert.equal(displayPath("/p", "/p"), resolve("/p"));
		assert.equal(planFile("/p", "docs/a.md"), resolve("/p/docs/a.md"));
		assert.equal(planFile("/p", "/abs/a.md"), resolve("/abs/a.md"));
	});

	it("reads a plan, or undefined when it is missing", async () => {
		const dir = await tmp();
		await writeFile(join(dir, "a.md"), "x");
		assert.equal(await readPlan(join(dir, "a.md")), "x");
		assert.equal(await readPlan(join(dir, "missing.md")), undefined);
	});
});

describe("handoff", () => {
	const plan = { path: "docs/plans/dedupe.md", feature: "Dedupe", slug: "dedupe", at: 1 };

	it("kicks off a build session with the path", () => {
		assert.equal(
			kickoff("docs/plans/dedupe.md"),
			'Build the plan at docs/plans/dedupe.md. Read the whole file first, then follow its "How to build this plan" section.',
		);
	});

	it("tells the builder about the plan until every slice is done", () => {
		const section = buildSection(plan, undefined)!;
		assert.match(section, /approved a plan for "Dedupe" at docs\/plans\/dedupe\.md/);
		assert.match(section, /Tick each box in the plan file/);
		assert.match(buildSection({ ...plan, feature: "" }, [])!, /plan for "dedupe"/);
		assert.ok(buildSection(plan, [{ number: 1, title: "t", total: 2, checked: 1 }]));
		assert.equal(buildSection(plan, [{ number: 1, title: "t", total: 2, checked: 2 }]), undefined);
	});
});

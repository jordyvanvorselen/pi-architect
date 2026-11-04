import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { diagramMaxWidth, GUIDE_EXAMPLE } from "../src/diagram/index.ts";
import { architectSection, DRAWING_RULES_HEAD, drawingRulesInContext, SECTION } from "../src/prompt.ts";
import { ENTRY_TYPE, event } from "../src/state/events.ts";
import { PHASES, type Phase } from "../src/state/phases.ts";
import { newArchitecture, reduce } from "../src/state/reducer.ts";
import type { Architecture } from "../src/state/types.ts";
import { type DiagramDetails, planDiagram, prepareDiagramArgs } from "../src/tools/diagram.ts";
import { diagramCall, diagramResult } from "../src/ui/diagram.ts";
import { harness } from "./harness.ts";
import { FakeUi, KEYS, plainTheme } from "./helpers.ts";

const BOX = "╭───────╮\n│ Panel │\n╰───────╯";
const BROKEN = "╭──────╮\n│ Orders │\n╰──────╯";

function at(partial: Partial<Architecture> = {}): Architecture {
	return { ...newArchitecture(1, "Dedupe", "dedupe"), phase: "explore", ...partial };
}

function apply(arch: Architecture, plan: ReturnType<typeof planDiagram>): Architecture {
	return reduce({ mode: "architect", architecture: arch }, event(plan.event!)).architecture!;
}

describe("planDiagram", () => {
	it("saves a clean diagram with the next id, the phase and a tidied body", () => {
		const plan = planDiagram(at(), { title: " Flow ", body: `\n  ${BOX.replace(/\n/g, "\n  ")}  \n`, caption: "Why." });
		assert.deepEqual(plan.event, {
			type: "diagram",
			diagram: { id: "d1", phase: "explore", title: "Flow", body: BOX, caption: "Why." },
		});
		assert.match(
			plan.text,
			/^Saved diagram d1 "Flow" \(3 lines, 9 cols\)\. The user sees it on screen\. Explore still needs at least one touched or new module\.$/,
		);
		const details = plan.details as Extract<DiagramDetails, { outcome: "saved" }>;
		assert.deepEqual([details.outcome, details.replaced, details.lines, details.cols], ["saved", false, 3, 9]);
	});

	it("rejects a misaligned diagram with the linter's findings and no event", () => {
		const plan = planDiagram(at(), { title: "Orders", body: BROKEN });
		assert.equal(plan.event, undefined);
		assert.match(plan.text, /^Diagram rejected: 1 error\..*\n- line 2 col 8 error: box side │ missing/s);
		assert.equal(plan.details.outcome, "rejected");
		assert.equal((plan.details as Extract<DiagramDetails, { outcome: "rejected" }>).findings[0]!.line, 2);
	});

	it("replaces a diagram by id and keeps the phase it was drawn for", () => {
		let arch = apply(at(), planDiagram(at(), { title: "Now", body: BOX }));
		arch = { ...arch, phase: "design" };
		const plan = planDiagram(arch, { id: "d1", title: "Now, revised", body: "A ──▶ B" });
		assert.deepEqual(plan.event!.diagram, { id: "d1", phase: "explore", title: "Now, revised", body: "A ──▶ B" });
		assert.match(plan.text, /^Replaced diagram d1/);
		assert.deepEqual(plan.details.outcome === "saved" && plan.details.missing, ["at least one diagram"]);
		const after = apply(arch, plan);
		assert.deepEqual(
			after.diagrams.map((d) => d.title),
			["Now, revised"],
		);
		assert.match(planDiagram(arch, { id: "d1", title: "x", body: BROKEN }).text, /Keep id "d1" to replace it\./);
	});

	it("tells the model which ids exist when the id is unknown", () => {
		assert.throws(
			() => planDiagram(at(), { id: "d9", title: "x", body: BOX }),
			/no diagram d9 to replace\. Diagrams: none/,
		);
	});

	it("is allowed from Explore on, not in Frame or after approval", () => {
		for (const phase of PHASES) {
			const run = () => planDiagram(at({ phase }), { title: "t", body: BOX });
			if (phase === "frame") assert.throws(run, /Diagrams start in Explore/);
			else assert.ok(run().event, phase);
		}
		assert.throws(() => planDiagram(at({ approvedAt: 5 }), { title: "t", body: BOX }), /approved and final/);
	});

	it("makes a Design diagram satisfy Design", () => {
		const plan = planDiagram(at({ phase: "design" }), { title: "t", body: BOX });
		assert.match(plan.text, /Design is ready: call architect_advance/);
	});

	it("passes warnings on without rejecting", () => {
		const plan = planDiagram(at(), { title: "t", body: `${BOX}\n    │\n    ▼\n\n╭───────╮\n│ Proc  │\n╰───────╯` });
		assert.ok(plan.event);
		assert.match(plan.text, /Warnings, fix them if you revise it: - line 4 col 5 warning: │ runs into ─ above/);
		assert.equal(plan.details.outcome === "saved" && plan.details.warnings.length, 2);
	});

	it("checks the width it is given", () => {
		const body = `A ──▶ ${"x".repeat(70)}`;
		assert.ok(planDiagram(at(), { title: "t", body }).event);
		assert.match(planDiagram(at(), { title: "t", body }, { maxWidth: 60 }).text, /wider than 60 cols/);
	});
});

describe("prepareDiagramArgs", () => {
	it("accepts the drawing under other names, as lines, or the call as JSON", () => {
		assert.deepEqual(prepareDiagramArgs({ name: "t", diagram: ["a", "b"], caption: null }), {
			title: "t",
			body: "a\nb",
		});
		assert.deepEqual(prepareDiagramArgs('{"title":"t","text":"x"}'), { title: "t", body: "x" });
		assert.deepEqual(prepareDiagramArgs({ title: "t", body: "keep", text: "other" }), {
			title: "t",
			body: "keep",
			text: "other",
		});
		assert.deepEqual(prepareDiagramArgs("nonsense"), {});
	});
});

describe("diagramMaxWidth", () => {
	it("leaves room for the card in the terminal, between 60 and 100 columns", () => {
		assert.equal(diagramMaxWidth(undefined), 100);
		assert.equal(diagramMaxWidth(200), 100);
		assert.equal(diagramMaxWidth(90), 82);
		assert.equal(diagramMaxWidth(50), 60);
	});
});

describe("diagram tool rendering", () => {
	const render = (component: { render(width: number): string[] }, width = 80) => component.render(width);
	const saved = planDiagram(at({ phase: "design" }), { title: "Panel flow", body: GUIDE_EXAMPLE });
	const rejected = planDiagram(at(), { title: "Orders", body: `${BROKEN}\n${BROKEN}\n${BROKEN}\n${BROKEN}` });
	const result = (plan: ReturnType<typeof planDiagram>) => ({
		content: [{ type: "text", text: plan.text }],
		details: plan.details,
	});

	it("names the diagram in the call", () => {
		assert.deepEqual(render(diagramCall({ title: "Flow", id: "d2" }, plainTheme, {})), [
			'◆ architect diagram  "Flow" · replaces d2',
		]);
		assert.deepEqual(render(diagramCall(undefined, plainTheme, {})), ["◆ architect diagram"]);
	});

	it("shows a one-line summary collapsed and the card expanded", () => {
		assert.deepEqual(render(diagramResult(result(saved), { expanded: false }, plainTheme, {}), 120), [
			'✓ saved d1 "Panel flow" · 8 × 67 · Design ready for review (ctrl+o to expand)',
		]);
		const hinted = diagramResult(result(saved), { expanded: false }, plainTheme, {
			keyHint: (_key, description) => `ctrl+x ${description}`,
		});
		assert.match(render(hinted, 120)[0]!, /\(ctrl\+x to expand\)$/);
		const lines = render(diagramResult(result(saved), { expanded: true }, plainTheme, {}));
		assert.equal(lines[0], '✓ saved d1 "Panel flow" · 8 × 67 · Design ready for review');
		assert.equal(lines[1], "╭─ Panel flow ──────────────────────────────────────────────────────────╮");
		assert.ok(lines.some((l) => l.includes("│ Panel ├─────────▶│ Processor [changed] ├")));
	});

	it("lists the findings of a rejected diagram, all of them when expanded", () => {
		const collapsed = render(diagramResult(result(rejected), { expanded: false }, plainTheme, {}), 100);
		assert.equal(collapsed[0], "✗ diagram rejected · 4 errors · the agent redraws it");
		assert.equal(collapsed.length, 5);
		assert.match(collapsed[1]!, /^ {2}✗ 2:8 box side │ missing/);
		assert.equal(collapsed[4], "  …1 more (ctrl+o to expand)");
		const expanded = render(diagramResult(result(rejected), { expanded: true }, plainTheme, {}), 60);
		assert.equal(expanded.filter((l) => l.startsWith("  ✗")).length, 4);
	});

	it("fits every width", () => {
		for (const width of [20, 30, 40, 80, 120]) {
			for (const expanded of [false, true]) {
				for (const plan of [saved, rejected]) {
					const lines = render(diagramResult(result(plan), { expanded }, plainTheme, {}), width);
					assert.ok(lines.length > 0);
					for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
				}
			}
			for (const line of render(diagramCall({ title: "A very long diagram title indeed" }, plainTheme, {}), width))
				assert.ok(visibleWidth(line) <= width);
		}
	});
});

describe("drawing rules in the prompt", () => {
	const section = (phase: Phase, drawingRulesInContext = false) =>
		architectSection({ mode: "architect", architecture: at({ phase }) }, { drawingRulesInContext }) ?? "";

	it("come with Explore and Design, where diagrams are drawn", () => {
		for (const phase of PHASES) {
			const has = section(phase).includes("Drawing diagrams for architect_diagram:\nDraw diagrams yourself");
			assert.equal(has, phase === "explore" || phase === "design", phase);
		}
		assert.ok(section("design").includes(GUIDE_EXAMPLE));
		assert.match(section("explore"), /Sketch the current architecture with architect_diagram/);
	});

	it("stay out when the architect_advance result that opened the phase already brought them", () => {
		assert.doesNotMatch(section("design", true), /Drawing diagrams/);
		assert.match(section("design", true), /architect_diagram/);
	});
});

describe("drawing rules sent once per phase", () => {
	const verdict = (phase: Phase) => ({
		type: "custom",
		customType: ENTRY_TYPE,
		data: { v: 1, type: "verdict", phase, verdict: "approved", at: 2 },
	});
	const advanced = (next: Phase, text: string, id = "r1") => ({
		type: "message",
		id,
		message: {
			role: "toolResult",
			toolName: "architect_advance",
			content: [{ type: "text", text }],
			details: { next },
		},
	});
	const rules = `Decide approved. Now in Design:\n${DRAWING_RULES_HEAD}\n…`;

	it("counts as sent when the architect_advance result that opened the phase brought them", () => {
		assert.equal(drawingRulesInContext([verdict("decide"), advanced("design", rules)], "design"), true);
		assert.equal(drawingRulesInContext([verdict("decide")], "design"), false);
		assert.equal(drawingRulesInContext([verdict("decide"), advanced("design", "no rules")], "design"), false);
		// A result from an earlier architecture does not count for the phase opened since.
		assert.equal(drawingRulesInContext([advanced("design", rules), verdict("decide")], "design"), false);
	});

	it("counts as gone once a compaction dropped the result", () => {
		const entries = [verdict("decide"), advanced("design", rules, "r1"), { type: "message", id: "m2" }];
		const compaction = (firstKeptEntryId: string) => ({ type: "compaction", id: "c", firstKeptEntryId });
		assert.equal(drawingRulesInContext([...entries, compaction("m2")], "design"), false);
		assert.equal(drawingRulesInContext([...entries, compaction("r1")], "design"), true);
	});

	it("leaves them out of the system prompt after the advance result brought them", async () => {
		const ui = new FakeUi().keys([KEYS.enter]);
		const h = harness({ ui });
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect");
		await h.call("architect_update", { feature: "Dedupe", brief: { goal: "g", done_when: ["d"] } });
		const result = await h.call("architect_advance", {});
		assert.match(result.content[0]!.text, new RegExp(DRAWING_RULES_HEAD));
		assert.match((await h.startRun()).sections[SECTION]!, new RegExp(DRAWING_RULES_HEAD));
		h.branch.push({
			type: "message",
			message: { role: "toolResult", toolName: "architect_advance", content: result.content, details: result.details },
		} as never);
		const section = (await h.startRun()).sections[SECTION]!;
		assert.doesNotMatch(section, /Drawing diagrams/);
		assert.match(section, /Phase 2\/6: Explore/);
	});
});

describe("architect_diagram end to end", () => {
	async function inExplore() {
		const h = harness({
			ui: new FakeUi(),
			overrides: { review: async () => ({ verdict: "approved", comment: "" }) },
			builtins: ["read", "bash"],
		});
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "Dedupe");
		await h.call("architect_update", { brief: { goal: "g", done_when: ["d"] } });
		const advanced = await h.call("architect_advance", {});
		return { h, advanced };
	}

	const diagrams = (h: Awaited<ReturnType<typeof inExplore>>["h"]) =>
		h.entries.filter((e) => e.data.type === "diagram").map((e) => e.data.diagram as { id: string; title: string });

	it("is registered inactive and turned on with the other architect tools", async () => {
		const { h } = await inExplore();
		assert.equal(h.tools.architect_diagram!.defaultActive, false);
		assert.ok(h.active().includes("architect_diagram"));
	});

	it("hands the model the drawing rules when Explore starts", async () => {
		const { advanced } = await inExplore();
		assert.match(
			advanced.content[0]!.text,
			/Now in Explore.*Drawing diagrams for architect_diagram:\nDraw diagrams yourself/s,
		);
	});

	it("stores accepted diagrams, rejects broken ones without an event, and replaces by id", async () => {
		const { h } = await inExplore();
		const saved = await h.call("architect_diagram", { title: "Current", body: BOX });
		assert.equal(saved.isError, undefined);
		const rejected = await h.call("architect_diagram", { title: "Broken", body: BROKEN });
		assert.equal(rejected.isError, true);
		assert.match(rejected.content[0]!.text, /^Diagram rejected/);
		assert.deepEqual(
			diagrams(h).map((d) => d.id),
			["d1"],
		);
		await h.call("architect_diagram", { id: "d1", title: "Current, fixed", body: "A ──▶ B" });
		assert.deepEqual(
			diagrams(h).map((d) => `${d.id}:${d.title}`),
			["d1:Current", "d1:Current, fixed"],
		);
		await h.call("architect_update", { remove: ["d1"] });
		await assert.rejects(h.call("architect_diagram", { id: "d1", title: "x", body: BOX }), /no diagram d1/);
	});

	it("refuses to work outside architect mode", async () => {
		const h = harness();
		await h.fire("session_start", { reason: "startup" });
		await assert.rejects(h.call("architect_diagram", { title: "t", body: BOX }), /only works in architect mode/);
	});
});

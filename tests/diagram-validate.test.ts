import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Value from "typebox/value";
import { DIAGRAM_GUIDE, diagramGuide, GUIDE_EXAMPLE } from "../src/diagram/guide.ts";
import { DiagramSchema } from "../src/diagram/types.ts";
import { MAX_FINDINGS, normalizeBody, validateDiagram } from "../src/diagram/validate.ts";

const BOX = ["╭───────╮", "│ Panel │", "╰───────╯"].join("\n");

describe("validateDiagram", () => {
	it("accepts a clean diagram and tidies its body", () => {
		const check = validateDiagram({
			title: "  Flow ",
			body: `\n\n    ${BOX.split("\n").join("   \n    ")}\n\n`,
			caption: " Why. ",
		});
		assert.equal(check.ok, true);
		assert.equal(check.errors, 0);
		assert.deepEqual(check.findings, []);
		assert.deepEqual(check.diagram, { title: "Flow", body: BOX, caption: "Why." });
		assert.equal(check.summary, "Diagram accepted.");
	});

	it("matches the schema the tool advertises", () => {
		assert.ok(Value.Check(DiagramSchema, { title: "t", body: BOX }));
		assert.ok(!Value.Check(DiagramSchema, { title: "t" }));
	});

	it("rejects wrong shapes with plain words", () => {
		assert.match(validateDiagram(null).summary, /must be an object: \{ title, body, caption\? \}/);
		const check = validateDiagram({ title: "", body: 3 });
		assert.equal(check.ok, false);
		assert.equal(check.diagram, undefined);
		assert.deepEqual(
			check.findings.map((f) => f.message),
			["title: give the diagram a short title.", "body: must be the drawing as text, lines separated by \\n."],
		);
	});

	it("rejects an empty body", () => {
		const check = validateDiagram({ title: "t", body: "  \n \n" });
		assert.equal(check.ok, false);
		assert.match(check.summary, /body: the drawing is empty/);
	});

	it("rejects tabs and says where they are", () => {
		const check = validateDiagram({ title: "t", body: "╭───╮\n│\tA │\n╰───╯" });
		assert.equal(check.ok, false);
		assert.deepEqual([check.findings[0]!.line, check.findings[0]!.col], [2, 2]);
		assert.match(check.findings[0]!.message, /use spaces/);
	});

	it("rejects colour codes", () => {
		const check = validateDiagram({ title: "t", body: "\x1b[32mA\x1b[0m ──▶ B" });
		assert.equal(check.ok, false);
		assert.match(check.summary, /colour codes on line 1/);
	});

	it("rejects double-escaped newlines", () => {
		const check = validateDiagram({ title: "t", body: "╭───╮\\n│ A │\\n╰───╯" });
		assert.equal(check.ok, false);
		assert.match(check.summary, /no line breaks/);
	});

	it("reports lines that are too wide and by how much", () => {
		const body = ["A ──▶ B", "x".repeat(112), "y".repeat(101)].join("\n");
		const check = validateDiagram({ title: "t", body });
		assert.equal(check.ok, false);
		assert.deepEqual([check.findings[0]!.line, check.findings[0]!.col], [2, 101]);
		assert.match(check.findings[0]!.message, /2 lines are wider than 100 cols: line 2 \(112\), line 3 \(101\)/);
		assert.equal(validateDiagram({ title: "t", body }, { maxWidth: 120 }).ok, true);
	});

	it("measures width in terminal columns", () => {
		const body = "日本".repeat(26);
		assert.match(validateDiagram({ title: "t", body }).summary, /line 1 \(104\)/);
	});

	it("rejects misaligned boxes with the finding and accepts warnings", () => {
		const broken = validateDiagram({ title: "t", body: "╭──────╮\n│ Orders │\n╰──────╯" });
		assert.equal(broken.ok, false);
		assert.ok(broken.diagram, "the tidied diagram is still there for reference");
		assert.match(
			broken.summary,
			/^Diagram rejected: 1 error\. Fix the errors and send the whole diagram again\.\n- line 2 col 8 error: box side/,
		);

		const warned = validateDiagram({ title: "t", body: `${BOX}\n    │\n    ▼\n\n╭───────╮\n│ Proc  │\n╰───────╯` });
		assert.equal(warned.ok, true);
		assert.equal(warned.warnings, 1);
		assert.match(warned.summary, /^Diagram accepted with 1 warning\./);
		// The line that ran into the box edge got its junction instead of a warning.
		assert.match(warned.diagram!.body, /╰───┬───╯/);
	});

	it("repairs a corner one column off, accepts the drawing and says what it changed", () => {
		const check = validateDiagram({ title: "t", body: "╭───────╮\n│ Panel │\n╰────────╯" });
		assert.equal(check.ok, true);
		assert.equal(check.diagram!.body, "╭───────╮\n│ Panel │\n╰───────╯");
		assert.deepEqual(check.repairs, [
			{ line: 3, col: 10, message: "moved ╯ from col 10 to col 9, in line with the corner on line 1" },
		]);
		assert.equal(
			check.summary,
			[
				"Diagram accepted.",
				"Repaired 1 alignment slip before showing it. Keep these when you revise it:",
				"- line 3 col 10: moved ╯ from col 10 to col 9, in line with the corner on line 1.",
			].join("\n"),
		);
	});

	it("lists the repairs it made on a drawing it still rejects", () => {
		const check = validateDiagram({
			title: "t",
			body: "╭───────╮\n│ Panel │\n╰────────╯\n╭──────╮\n│ Orders │\n╰──────╯",
		});
		assert.equal(check.ok, false);
		assert.match(check.summary, /line 5 col 8 error: box side/);
		const lines = check.summary.split("\n");
		assert.equal(
			lines[0],
			"Diagram rejected: 1 error left after repairing 1 alignment slip. Fix the errors and send the whole diagram again.",
		);
		assert.deepEqual(lines.slice(1, 4), [
			"Already repaired by the checker, nothing to do for these:",
			"- line 3 col 10: moved ╯ from col 10 to col 9, in line with the corner on line 1.",
			"Still wrong (lines and columns of the repaired drawing below):",
		]);
		assert.match(lines[4]!, /^- line 5 col 8 error: box side/);
		assert.deepEqual(lines.slice(5), [
			"The repaired drawing, to fix and send again:",
			"```",
			"╭───────╮",
			"│ Panel │",
			"╰───────╯",
			"╭──────╮",
			"│ Orders │",
			"╰──────╯",
			"```",
		]);
	});

	it("suggests the real status markers", () => {
		const check = validateDiagram({ title: "t", body: "Cache [added] ──▶ DB [modified]" });
		assert.equal(check.ok, true);
		assert.deepEqual(
			check.findings.map((f) => [f.line, f.col, f.message]),
			[
				[1, 7, "[added] is not a status marker: use [new]."],
				[1, 22, "[modified] is not a status marker: use [changed]."],
			],
		);
	});

	it("caps the findings but counts them all", () => {
		const row = "╭──╮ ".repeat(14);
		const check = validateDiagram({ title: "t", body: `${row}\n${"│ x  ".repeat(14)}\n${"╰──╯ ".repeat(14)}` });
		assert.equal(check.ok, false);
		assert.equal(check.findings.length, MAX_FINDINGS);
		assert.ok(check.errors > MAX_FINDINGS);
		assert.match(check.summary, /…and \d+ more\.$/);
	});

	it("warns about very tall diagrams", () => {
		const check = validateDiagram({ title: "t", body: Array.from({ length: 70 }, (_, i) => `step ${i}`).join("\n") });
		assert.equal(check.ok, true);
		assert.match(check.summary, /70 lines tall/);
	});
});

describe("normalizeBody", () => {
	it("keeps relative indentation and drops blank edges", () => {
		assert.equal(normalizeBody("\r\n   a  \r\n     b\n\n"), "a\n  b");
	});
});

describe("DIAGRAM_GUIDE", () => {
	it("is short and covers the rules the linter checks", () => {
		const lines = DIAGRAM_GUIDE.split("\n");
		assert.ok(lines.length <= 25, `${lines.length} lines`);
		for (const part of [
			"╭───╮",
			"├ ┤ ┬ ┴ ┼",
			"┄",
			"▶ ◀ ▼ ▲",
			"[new]",
			"[changed]",
			"[removed]",
			"100 columns",
			"tabs",
		]) {
			assert.ok(DIAGRAM_GUIDE.includes(part), part);
		}
		assert.ok(DIAGRAM_GUIDE.includes(GUIDE_EXAMPLE));
	});

	it("says bash cannot count columns, and to build every row of a box from one template", () => {
		assert.match(DIAGRAM_GUIDE, /Bash cannot count columns for you/);
		assert.match(DIAGRAM_GUIDE, /Build every row of a box from one template/);
		assert.match(DIAGRAM_GUIDE, /one corner style per box/);
	});

	it("follows the width it is given", () => {
		assert.match(diagramGuide(72), /At most 72 columns/);
	});

	it("has an example the validator accepts without findings", () => {
		const check = validateDiagram({ title: "Example", body: GUIDE_EXAMPLE });
		assert.equal(check.summary, "Diagram accepted.");
	});
});

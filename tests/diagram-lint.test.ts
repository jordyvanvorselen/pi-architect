import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { lintBody } from "../src/diagram/lint.ts";
import { GUIDE_EXAMPLE } from "../src/diagram/guide.ts";

const FIXTURES = new URL("./fixtures/diagram/", import.meta.url);

function fixture(kind: "good" | "bad", name: string): string[] {
	return readFileSync(new URL(`${kind}/${name}`, FIXTURES), "utf8")
		.replace(/\n$/, "")
		.split("\n");
}

function names(kind: "good" | "bad"): string[] {
	return readdirSync(new URL(`${kind}/`, FIXTURES)).filter((f) => f.endsWith(".txt"));
}

describe("diagram linter on correct diagrams", () => {
	for (const name of names("good")) {
		it(`finds nothing in ${name}`, () => {
			assert.deepEqual(lintBody(fixture("good", name)), []);
		});
	}

	it("finds nothing in the guide example", () => {
		assert.deepEqual(lintBody(GUIDE_EXAMPLE.split("\n")), []);
	});

	it("never flags text between boxes", () => {
		const lines = [
			"╭─────╮ reads the queue, then ╭─────╮",
			"│  A  ├──────────────────────▶│  B  │",
			"╰─────╯  (every 5 s) ──▶ ok   ╰─────╯",
			"   │ ▲ ┤ ├ ─ mid-text symbols ▼ ◀",
		];
		assert.deepEqual(
			lintBody(lines).filter((f) => f.line !== 4),
			[],
		);
	});
});

/** What each broken fixture must report: [line, col, severity, part of the message]. */
const EXPECTED: Record<string, [number, number, "error" | "warning", string][]> = {
	"shifted-corner.txt": [[3, 10, "error", "╯ is 1 col off: it must be at col 9"]],
	"shifted-top.txt": [[1, 10, "error", "╮ is 1 col off: it must be at col 9"]],
	"short-side.txt": [[3, 1, "error", "box side │ missing (box opened at line 1 col 1)"]],
	"ragged.txt": [[2, 8, "error", "This line's │ is at col 10, 2 cols too far right"]],
	"emoji.txt": [[2, 12, "error", "wide characters (🚀)"]],
	"dangling-junction.txt": [[3, 5, "error", "┬ has nothing below"]],
	"junction-arm.txt": [[2, 11, "error", "┤ has nothing above or below"]],
	"gap-arrow.txt": [[2, 17, "error", "gap between the line and ▶"]],
	"bus-misaligned.txt": [
		[3, 12, "error", "The ┴ it should meet is 1 col right, at line 4 col 13"],
		[4, 13, "error", "┴ does not join ─ above"],
	],
	"arrow-short.txt": [[5, 5, "warning", "▼ stops 1 row short"]],
	"dangling-arrow.txt": [[5, 5, "warning", "▼ points at nothing"]],
	"missing-arm.txt": [[4, 5, "warning", "│ runs into ─ above without joining it"]],
	"crossing-no-junction.txt": [[2, 11, "warning", "─ runs into │ to its right"]],
	"side-one-off.txt": [[3, 9, "error", "This line's │ is at col 8, 1 col too far left"]],
	"junction-outside.txt": [[2, 7, "error", "This line's │ is at col 6, 1 col too far left"]],
	"corner-short.txt": [[3, 8, "error", "╯ is 1 col off: it must be at col 9"]],
	"bottom-left-off.txt": [[3, 2, "error", "╰ is 1 col off: it must be at col 1"]],
	"top-short.txt": [[1, 9, "error", "╮ is 1 col off: it must be at col 10"]],
	"ambiguous-sides.txt": [[4, 10, "error", "╯ is 1 col off"]],
	"line-into-line.txt": [[2, 2, "warning", "─ runs into │ to its right"]],
	"side-two-off.txt": [[2, 9, "error", "This line's │ is at col 11, 2 cols too far right"]],
	"corner-side-two-off.txt": [[1, 9, "error", "╮ is 2 cols off: it must be at col 11"]],
	"top-two-long.txt": [[1, 11, "error", "╮ is 2 cols off: it must be at col 9"]],
	"side-drift-uneven.txt": [[2, 9, "error", "This line's │ is at col 11, 2 cols too far right"]],
	"side-two-off-text.txt": [[2, 7, "error", "This line's │ is at col 9, 2 cols too far right"]],
	"mixed-corners.txt": [[1, 9, "warning", "corner ┐ does not match the other corners of the box"]],
	"mixed-corners-even.txt": [[1, 9, "warning", "the corners of the box mix ╭ and ┌ styles"]],
};

describe("diagram linter on broken diagrams", () => {
	it("has an expectation for every broken fixture", () => {
		assert.deepEqual(names("bad").sort(), Object.keys(EXPECTED).sort());
	});

	for (const [name, expected] of Object.entries(EXPECTED)) {
		it(`reports ${name}`, () => {
			const findings = lintBody(fixture("bad", name));
			assert.equal(findings.length, expected.length, JSON.stringify(findings, null, 2));
			findings.forEach((f, i) => {
				const [line, col, severity, text] = expected[i]!;
				assert.deepEqual([f.line, f.col, f.severity], [line, col, severity], f.message);
				assert.ok(f.message.includes(text), `"${f.message}" should include "${text}"`);
			});
		});
	}

	it("puts errors before warnings", () => {
		const lines = ["╭───╮", "│ A │", "╰───╯", "  │", "  ▼", "", "╭───────╮", "│ B │", "╰───────╯"];
		const findings = lintBody(lines);
		assert.ok(findings.length >= 2);
		assert.equal(findings[0]!.severity, "error");
		assert.equal(findings.at(-1)!.severity, "warning");
	});

	it("reports a broken box once, not once per corner", () => {
		const findings = lintBody(["╭──────╮", "│ Orders │", "│ api    │", "╰──────╯"]);
		assert.equal(findings.length, 1);
		assert.match(findings[0]!.message, /box side │ missing \(2 lines\)/);
	});
});

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { GUIDE_EXAMPLE } from "../src/diagram/guide.ts";
import { lintBody } from "../src/diagram/lint.ts";
import { reflowBody } from "../src/diagram/reflow.ts";
import { repairBody } from "../src/diagram/repair.ts";

const FIXTURES = new URL("./fixtures/diagram/", import.meta.url);
const fixture = (kind: "good" | "bad", name: string) =>
	readFileSync(new URL(`${kind}/${name}`, FIXTURES), "utf8")
		.replace(/\n$/, "")
		.split("\n");
const names = (kind: "good" | "bad") => readdirSync(new URL(`${kind}/`, FIXTURES)).filter((f) => f.endsWith(".txt"));

/** The drawing after repair, for the broken fixtures with one clear reading. `null`: left for the model. */
const REPAIRED: Record<string, string[] | null> = {
	"shifted-corner.txt": ["╭───────╮", "│ Panel │", "╰───────╯"],
	"shifted-top.txt": ["╭───────╮", "│ Panel │", "│       │", "╰───────╯"],
	"corner-short.txt": ["╭───────╮", "│ Panel │", "╰───────╯"],
	"bottom-left-off.txt": ["╭───────╮", "│ Panel │", "╰───────╯"],
	"top-short.txt": ["╭────────╮", "│ Panel  │", "╰────────╯"],
	"side-one-off.txt": ["╭───────╮", "│ Panel │", "│ Proc  │", "╰───────╯"],
	"junction-outside.txt": ["      ╭───────╮", "──────┤Panel  │", "      ╰───────╯"],
	"crossing-no-junction.txt": ["╭─────╮    ╭─────╮", "│ A   ├────┤ B   │", "╰─────╯    ╰─────╯"],
	"side-two-off.txt": ["╭───────╮", "│ Panel │", "│ Proc  │", "╰───────╯"],
	"corner-side-two-off.txt": ["╭─────────╮", "│ Panel   │", "│ Proc    │", "╰─────────╯"],
	"top-two-long.txt": ["╭───────╮", "│ Panel │", "│ Proc  │", "╰───────╯"],
	"mixed-corners.txt": ["╭───────╮", "│ Panel │", "╰───────╯"],
	"missing-arm.txt": ["╭───────╮", "│ Panel │", "╰───┬───╯", "    │", "    ▼", "╭───────╮", "│ Proc  │", "╰───────╯"],
	// Two columns off, a side that is gone, two different side columns, a junction against a junction,
	// wide characters, and lines that meet no box: more than one reading, or none.
	"ragged.txt": null,
	// A side that drifts row by row is reflowed to the columns its top edge set, and so is a side that
	// wanders off and back: the top edge is the anchor.
	"side-drift-uneven.txt": ["╭───────╮", "│ Panel │", "│ Proc  │", "╰───────╯"],
	"ambiguous-sides.txt": ["╭───────╮", "│ Panel │", "│ Pro   │", "╰───────╯"],
	// Text in the way, and corners two and two of each style.
	"side-two-off-text.txt": null,
	"mixed-corners-even.txt": null,
	"short-side.txt": null,
	"bus-misaligned.txt": null,
	"emoji.txt": null,
	"line-into-line.txt": null,
	"junction-arm.txt": null,
	"dangling-junction.txt": null,
	"gap-arrow.txt": null,
	"arrow-short.txt": null,
	"dangling-arrow.txt": null,
};

describe("diagram repair", () => {
	it("has an expectation for every broken fixture", () => {
		assert.deepEqual(names("bad").sort(), Object.keys(REPAIRED).sort());
	});

	for (const [name, expected] of Object.entries(REPAIRED)) {
		it(expected ? `repairs ${name} into a drawing without findings` : `leaves ${name} for the model`, () => {
			const lines = fixture("bad", name);
			const { lines: repaired, repairs } = repairBody(lines);
			if (!expected) {
				assert.deepEqual(repairs, []);
				assert.deepEqual(repaired, lines);
				return;
			}
			assert.deepEqual(repaired, expected);
			assert.equal(repairs.length, 1);
			assert.deepEqual(lintBody(repaired), []);
		});
	}

	for (const name of names("good")) {
		it(`changes nothing in ${name}`, () => {
			const lines = fixture("good", name);
			assert.deepEqual(repairBody(lines), { lines, repairs: [] });
		});
	}

	it("changes nothing in the guide example", () => {
		const lines = GUIDE_EXAMPLE.split("\n");
		assert.deepEqual(repairBody(lines).repairs, []);
	});

	it("repairs every slip of a drawing, one by one", () => {
		const lines = ["╭───────╮   ╭──────╮", "│ Panel │   │ Proc │", "╰────────╯  ╰─────╯"];
		const { lines: repaired, repairs } = repairBody(lines);
		assert.deepEqual(repaired, ["╭───────╮   ╭──────╮", "│ Panel │   │ Proc │", "╰───────╯   ╰──────╯"]);
		assert.equal(repairs.length, 2);
	});

	it("says so when moving a side draws a line into the cell it left", () => {
		const { repairs } = repairBody(fixture("bad", "junction-outside.txt"));
		assert.deepEqual(
			repairs.map((r) => r.message),
			[
				"moved the box side ┤ to col 7 on line 2 (it was at col 6), in line with the box opened at line 1 col 7, and drew ─ at col 6",
			],
		);
	});

	it("does not move a side that a line above or below belongs to", () => {
		// Line 3 misses its right side, and the │ next to it is a divider that runs on from line 2.
		const lines = ["╭───────╮", "│ Pan  ││", "│ Pro  │", "╰──────┴╯"];
		assert.ok(lintBody(lines).some((f) => f.severity === "error"));
		assert.deepEqual(repairBody(lines).repairs, []);
	});
});

const DRIFT = new URL("drift/", FIXTURES);
const driftCases = readdirSync(DRIFT)
	.filter((f) => f.endsWith(".txt") && !f.endsWith(".fixed.txt"))
	.map((f) => f.replace(/\.txt$/, ""));
const read = (name: string) => readFileSync(new URL(name, DRIFT), "utf8").replace(/\n$/, "").split("\n");
/** The words of a drawing in order, without lines, arrows and spacing. */
const words = (lines: readonly string[]) =>
	lines
		.join("\n")
		.replace(/[\u2500-\u257f▶◀▼▲]/g, " ")
		.split(/\s+/)
		.filter(Boolean);

describe("diagram reflow", () => {
	it("has drift cases", () => {
		assert.deepEqual(driftCases, [
			"drift-arrow-labels",
			"drift-both-boxes",
			"drift-in-frame",
			"drift-three-boxes",
			"drift-two-boxes",
		]);
	});

	for (const name of driftCases) {
		it(`realigns ${name} without changing its text`, () => {
			const lines = read(`${name}.txt`);
			assert.ok(lintBody(lines).some((f) => f.severity === "error"));
			const { lines: repaired, repairs } = repairBody(lines);
			assert.deepEqual(repaired, read(`${name}.fixed.txt`));
			assert.deepEqual(lintBody(repaired), []);
			assert.deepEqual(words(repaired), words(lines));
			assert.ok(repairs.length > 0 && repairs.every((r) => r.message.startsWith("realigned ")));
		});
	}

	it("says which box it realigned, where, and by how much", () => {
		const { repairs } = repairBody(read("drift-two-boxes.txt"));
		assert.deepEqual(repairs, [
			{
				line: 3,
				col: 1,
				message:
					'realigned the right side of box "Client" on lines 3–5 and its bottom edge on line 6 (padding was off by 1–2 cols)',
			},
		]);
	});

	it("handles drift that grows on every row, like ╮ at 65 and sides at 65, 65, 66, 67", () => {
		const pad = (text: string, width: number) => text + " ".repeat(width - text.length);
		const lines = [
			`╭${"─".repeat(63)}╮   ╭────────╮`,
			`│${pad(" Server", 63)}│   │ Store  │`,
			`│${pad(" routes", 63)}│   │ sqlite │`,
			`│${pad(" handlers", 64)}│   │ file   │`,
			`│${pad(" validation", 65)}│   │ wal    │`,
			`╰${"─".repeat(65)}╯   ╰────────╯`,
		];
		const { lines: repaired, repairs } = repairBody(lines);
		assert.deepEqual(lintBody(repaired), []);
		assert.ok(repaired.every((l) => l.indexOf("│   │") === 64 || l.startsWith("╭") || l.startsWith("╰")));
		assert.equal(repairs.length, 1);
	});

	it("leaves an edge with two equally near readings alone", () => {
		// The right side is missing on line 2, with a │ one column to each side of its column.
		assert.equal(reflowBody(["╭───────╮", "│ Pan  │ │", "╰───────╯"]), undefined);
	});

	it("leaves a row alone when the only spaces to delete keep text off a border", () => {
		assert.equal(reflowBody(["╭─────╮", "│ Panel│", "╰─────╯"]), undefined);
	});

	it("never merges words to make room", () => {
		const lines = ["╭──────────╮", "│ Big Server │", "╰──────────╯"];
		assert.equal(reflowBody(lines), undefined);
		assert.deepEqual(repairBody(lines).lines, lines);
	});

	it("changes nothing in a drawing without drift", () => {
		for (const name of names("good")) assert.equal(reflowBody(fixture("good", name)), undefined, name);
	});
});

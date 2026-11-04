import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { GUIDE_EXAMPLE } from "../src/diagram/guide.ts";
import { lintBody } from "../src/diagram/lint.ts";
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
	"missing-arm.txt": ["╭───────╮", "│ Panel │", "╰───┬───╯", "    │", "    ▼", "╭───────╮", "│ Proc  │", "╰───────╯"],
	// Two columns off, a side that is gone, two different side columns, a junction against a junction,
	// wide characters, and lines that meet no box: more than one reading, or none.
	"ragged.txt": null,
	"short-side.txt": null,
	"ambiguous-sides.txt": null,
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

	it("does not move a side that a line above or below belongs to", () => {
		// Line 3 misses its right side, and the │ next to it is a divider that runs on from line 2.
		const lines = ["╭───────╮", "│ Pan  ││", "│ Pro  │", "╰──────┴╯"];
		assert.ok(lintBody(lines).some((f) => f.severity === "error"));
		assert.deepEqual(repairBody(lines).repairs, []);
	});
});

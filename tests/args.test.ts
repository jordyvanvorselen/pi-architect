import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArchitectArgs } from "../src/args.ts";

const SUBS = ["board", "review", "plan", "build", "reset"] as const;
const parse = (text: string) => parseArchitectArgs(text, SUBS);

describe("parsing /architect arguments", () => {
	it("reads a subcommand as the first word, in any case, with the rest", () => {
		assert.deepEqual(parse("  "), { kind: "none" });
		assert.deepEqual(parse("Board"), { kind: "subcommand", sub: "board", rest: "" });
		assert.deepEqual(parse("plan  open"), { kind: "subcommand", sub: "plan", rest: "open" });
	});

	it("names a feature with anything else", () => {
		assert.deepEqual(parse("Dedupe panel events"), { kind: "feature", name: "Dedupe panel events" });
	});

	it("finds a subcommand with text glued to it suspect, also for real words that start with one", () => {
		assert.deepEqual(parse("board6cSplit…"), { kind: "suspect", sub: "board", name: "board6cSplit…" });
		assert.deepEqual(parse("Builder cleanup"), { kind: "suspect", sub: "build", name: "Builder cleanup" });
	});

	it("names a feature exactly as quoted, even one that starts with a subcommand", () => {
		assert.deepEqual(parse('"build pipeline"'), { kind: "feature", name: "build pipeline" });
		assert.deepEqual(parse("'Reset flow'"), { kind: "feature", name: "Reset flow" });
		assert.deepEqual(parse("“Board games”"), { kind: "feature", name: "Board games" });
		assert.deepEqual(parse('""'), { kind: "none" });
	});
});

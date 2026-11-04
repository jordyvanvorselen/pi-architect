// The text the model and the user read about the tools must match what the tools take.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { phaseGuidance } from "../src/prompt.ts";
import { harness } from "./harness.ts";

const schemaOf = (h: ReturnType<typeof harness>, tool: string) =>
	h.tools[tool]!.parameters as {
		properties: Record<string, { description?: string; items?: { properties: object; required?: string[] } }>;
	};

describe("tool text matches the schemas", () => {
	it("architect_update says remove takes what the schema says", () => {
		const h = harness();
		const description = h.tools.architect_update!.description;
		const remove = schemaOf(h, "architect_update").properties.remove!.description!;
		assert.match(remove, /findings, risks or diagrams, or module paths/);
		assert.match(description, /remove takes ids of findings, risks or diagrams, and module paths\./);
	});

	it("the Slice guidance names every field a slice needs", () => {
		const h = harness();
		const required = schemaOf(h, "architect_slice").properties.slices!.items!.required!;
		const guidance = phaseGuidance("slice")[0]!;
		for (const field of required) assert.ok(guidance.includes(field), `Slice guidance leaves out ${field}`);
		assert.ok(required.includes("goal"));
	});

	it("the diagram guideline does not point to drawing rules where there are none", () => {
		const h = harness();
		const guideline = h.tools.architect_diagram!.promptGuidelines!.join(" ");
		assert.doesNotMatch(guideline, /phase guidance/);
		assert.match(guideline, /Explore and Design come with drawing rules/);
	});

	it("the README names every architect tool", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		for (const name of Object.keys(harness().tools)) assert.ok(readme.includes(`\`${name}\``), `README misses ${name}`);
	});
});

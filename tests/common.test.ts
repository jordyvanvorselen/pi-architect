import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerAdvanceTool } from "../src/tools/advance.ts";
import { architecture, clean, parseJson, readiness, textOf, textRow } from "../src/tools/common.ts";
import { registerDecideTool } from "../src/tools/decide.ts";
import { registerDiagramTool } from "../src/tools/diagram.ts";
import { registerSliceTool } from "../src/tools/slice.ts";
import { registerUpdateTool } from "../src/tools/update.ts";
import { INITIAL_STATE, newArchitecture } from "../src/state/reducer.ts";

describe("shared tool helpers", () => {
	it("parses objects and lists sent as JSON strings, and leaves other values alone", () => {
		assert.deepEqual(parseJson(' {"a": 1} '), { a: 1 });
		assert.deepEqual(parseJson('["x"]'), ["x"]);
		assert.equal(parseJson("[not json"), "[not json");
		assert.equal(parseJson("plain"), "plain");
		assert.equal(parseJson(3), 3);
	});

	it("trims list items and drops the empty ones", () => {
		assert.deepEqual(clean([" a ", "", "  ", "b"]), ["a", "b"]);
		assert.deepEqual(clean(undefined), []);
	});

	it("joins the text parts of a result", () => {
		assert.equal(textOf([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\n\nb");
	});

	it("ends a result with what the phase still needs, or that it is ready", () => {
		assert.equal(readiness("explore", ["a module"]), "Explore still needs a module.");
		assert.equal(readiness("slice", []), "Slice is ready: call architect_advance when the user should review it.");
	});

	it("refuses to work outside architect mode", () => {
		assert.throws(() => architecture(INITIAL_STATE, "architect_x"), /architect_x only works in architect mode/);
		const arch = newArchitecture(1);
		assert.equal(architecture({ mode: "architect", architecture: arch }, "architect_x"), arch);
	});

	it("reuses the component of the last render for the call and the result row", () => {
		const call = textRow({}, "call");
		assert.equal(textRow({ lastComponent: call }, "result"), call);
		assert.deepEqual(
			call.render(10).map((l) => l.trimEnd()),
			["result"],
		);
	});
});

describe("tool registration", () => {
	it("every tool registers itself from its own module, inactive by default", () => {
		const names: string[] = [];
		const pi = {
			registerTool: (tool: { name: string; defaultActive?: boolean }) => {
				assert.equal(tool.defaultActive, false);
				names.push(tool.name);
			},
		} as never;
		const deps = { state: () => INITIAL_STATE, append: () => {} };
		registerUpdateTool(pi, deps);
		registerAdvanceTool(pi, { ...deps, review: async () => undefined, now: () => 1 });
		registerDiagramTool(pi, deps);
		registerDecideTool(pi, { ...deps, ui: async () => undefined });
		registerSliceTool(pi, deps);
		assert.deepEqual(names, [
			"architect_update",
			"architect_advance",
			"architect_diagram",
			"architect_decide",
			"architect_slice",
		]);
	});
});

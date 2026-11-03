import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { GUIDE_EXAMPLE } from "../src/diagram/guide.ts";
import { DiagramView, SCROLL_STEP } from "../src/diagram/index.ts";

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

function view(onClose?: () => void) {
	return new DiagramView({ title: "Flow", body: GUIDE_EXAMPLE, caption: "Why it matters." }, plainTheme, {
		...(onClose ? { onClose } : {}),
	});
}

describe("DiagramView", () => {
	it("shows everything without a scroll footer when it fits", () => {
		const lines = view().render(100);
		assert.equal(lines[0], "Flow");
		assert.equal(lines[3], GUIDE_EXAMPLE.split("\n")[1]);
		assert.ok(lines.includes("Why it matters."));
		assert.equal(lines.at(-1), "■ new  ■ changed");
	});

	it("scrolls sideways with arrows and h/l, clamped to the drawing", () => {
		const v = view();
		let lines = v.render(40);
		assert.equal(lines.at(-1), "  cols 1–40 of 67 ▶  ←/→ scroll");
		assert.equal(lines[3], "│ Panel ├─────────▶│ Processor [changed]");

		v.handleInput(RIGHT);
		lines = v.render(40);
		assert.equal(v.scroll, SCROLL_STEP);
		assert.equal(lines[3], "├─────────▶│ Processor [changed] ├┄┄┄┄┄┄");
		assert.equal(lines.at(-1), "◀ cols 9–48 of 67 ▶  ←/→ scroll");

		for (let i = 0; i < 10; i++) v.handleInput("l");
		lines = v.render(40);
		assert.equal(v.scroll, 27);
		assert.equal(lines.at(-1), "◀ cols 28–67 of 67    ←/→ scroll");

		v.handleInput(LEFT);
		v.handleInput("h");
		assert.equal(v.scroll, 27 - 2 * SCROLL_STEP);
		v.handleInput("0");
		assert.equal(v.scroll, 0);
		v.handleInput("$");
		assert.equal(v.scroll, 27);
	});

	it("keeps every line inside the width while scrolled", () => {
		const v = view();
		for (const width of [20, 33, 40, 66]) {
			for (let i = 0; i < 12; i++) {
				for (const line of v.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
				v.handleInput(RIGHT);
			}
		}
	});

	it("pulls the scroll back when the view gets wider", () => {
		const v = view();
		v.render(40);
		v.handleInput("$");
		v.render(60);
		assert.equal(v.scroll, 7);
		v.render(100);
		assert.equal(v.scroll, 0);
	});

	it("does not cut a wide character in half at either edge", () => {
		const v = new DiagramView({ title: "t", body: "🚀🚀🚀🚀🚀🚀 end" }, plainTheme);
		assert.equal(v.render(5)[2], "🚀🚀 ");
		v.handleInput(RIGHT);
		const scrolled = v.render(5)[2]!;
		assert.equal(visibleWidth(scrolled), 5);
	});

	it("closes on esc or q", () => {
		let closed = 0;
		const v = view(() => closed++);
		v.handleInput("\x1b");
		v.handleInput("q");
		assert.equal(closed, 2);
	});
});

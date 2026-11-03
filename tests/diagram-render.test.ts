import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { GUIDE_EXAMPLE } from "../src/diagram/guide.ts";
import { renderDiagram } from "../src/diagram/index.ts";

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const tagTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<b>${text}</b>`,
	strikethrough: (text: string) => `<s>${text}</s>`,
};

const EXAMPLE = {
	title: "Panel event flow",
	body: GUIDE_EXAMPLE,
	caption: "The processor drops duplicates before they reach the backend.",
};

const GOOD = new URL("./fixtures/diagram/good/", import.meta.url);
const corpus = readdirSync(GOOD)
	.filter((f) => f.endsWith(".txt"))
	.map((f) => ({ title: f.replace(/\.txt$/, ""), body: readFileSync(new URL(f, GOOD), "utf8") }));

describe("renderDiagram", () => {
	it("shows the diagram in a titled card when it fits", () => {
		assert.deepEqual(renderDiagram(EXAMPLE, 80, plainTheme), [
			"╭─ Panel event flow ────────────────────────────────────────────────────╮",
			"│                                                                       │",
			"│  ╭───────╮  events  ╭─────────────────────╮  dedupe  ╭─────────────╮  │",
			"│  │ Panel ├─────────▶│ Processor [changed] ├┄┄┄┄┄┄┄┄┄▶│ Redis [new] │  │",
			"│  ╰───────╯          ╰──────────┬──────────╯          ╰─────────────╯  │",
			"│                                │ HTTP                                 │",
			"│                                ▼                                      │",
			"│                       ╭─────────────────╮                             │",
			"│                       │   Backend API   │                             │",
			"│                       ╰─────────────────╯                             │",
			"│                                                                       │",
			"│  The processor drops duplicates before they reach the backend.        │",
			"│                                                                       │",
			"╰─ ■ new  ■ changed ────────────────────────────────────────────────────╯",
		]);
	});

	it("drops the card before it cuts the drawing", () => {
		const lines = renderDiagram(EXAMPLE, 68, plainTheme);
		assert.equal(lines[0], "Panel event flow");
		assert.equal(lines[2], "│ Panel ├─────────▶│ Processor [changed] ├┄┄┄┄┄┄┄┄┄▶│ Redis [new] │");
		assert.ok(!lines.some((l) => l.includes("cols wide")));
	});

	it("cuts a drawing that is too wide, never wraps it, and says so", () => {
		assert.deepEqual(renderDiagram(EXAMPLE, 50, plainTheme), [
			"Panel event flow",
			"╭───────╮  events  ╭─────────────────────╮  dedup…",
			"│ Panel ├─────────▶│ Processor [changed] ├┄┄┄┄┄┄┄…",
			"╰───────╯          ╰──────────┬──────────╯       …",
			"                              │ HTTP",
			"                              ▼",
			"                     ╭─────────────────╮",
			"                     │   Backend API   │",
			"                     ╰─────────────────╯",
			"The processor drops duplicates before they reach",
			"the backend.",
			"■ new  ■ changed",
			"67 cols wide · open /architect board to see it all",
		]);
		const wide = renderDiagram(EXAMPLE, 66, plainTheme, { fullView: "the board" });
		assert.equal(wide.at(-1), "diagram is 67 cols wide, widen the terminal or open the board");
	});

	for (const width of [30, 40, 60, 80, 120]) {
		it(`fits every corpus diagram in ${width} columns`, () => {
			for (const d of [EXAMPLE, ...corpus]) {
				const lines = renderDiagram(d, width, plainTheme);
				assert.ok(lines.length > 0 && lines.some((l) => l.trim()), d.title);
				for (const line of lines) assert.ok(visibleWidth(line) <= width, `${d.title} @${width}: ${line}`);
			}
		});
	}

	it("never returns nothing, even absurdly narrow", () => {
		for (const width of [0, 1, 5, 12]) {
			const lines = renderDiagram(EXAMPLE, width, plainTheme);
			assert.ok(lines.length > 0);
			for (const line of lines) assert.ok(visibleWidth(line) <= Math.max(1, width), line);
		}
	});

	it("keeps wide characters whole and never splits one at the edge", () => {
		const d = { title: "🚀 日本", body: "╭──────────────╮\n│ 日本 service │\n╰──────────────╯\n🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀" };
		for (const width of [9, 10, 11, 16, 30]) {
			for (const line of renderDiagram(d, width, plainTheme))
				assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		}
		assert.deepEqual(renderDiagram(d, 12, plainTheme).slice(0, 3), ["🚀 日本", "╭──────────…", "│ 日本 serv…"]);
		assert.equal(renderDiagram(d, 12, plainTheme)[4], "🚀🚀🚀🚀🚀 …");
	});

	it("colours lines and arrows quietly and marked parts by status", () => {
		const body = [
			"╭─────────────╮     ╭───────╮",
			"│ Redis [new] │◀────┤ Proc  │",
			"╰─────────────╯     ╰───────╯",
			"Audit [removed] ┄┄▶ gone",
			"╭──────────────────╮",
			"│ Parser [changed] │",
			"│ keeps order      │",
			"╰──────────────────╯",
		].join("\n");
		const lines = renderDiagram({ title: "T", body }, 40, tagTheme);
		assert.equal(
			lines[0],
			"<borderMuted>╭─ </borderMuted><accent><b>T</b></accent><borderMuted> ──────────────────────────────────╮</borderMuted>",
		);
		assert.equal(
			lines[3],
			"<borderMuted>│</borderMuted>  <success>│</success> <success><b>Redis</b></success> <success>[new] │</success><borderAccent>◀</borderAccent><muted>────┤</muted> Proc  <muted>│</muted>       <borderMuted>│</borderMuted>",
		);
		assert.equal(
			lines[5],
			"<borderMuted>│</borderMuted>  <error><b><s>Audit</s></b></error> <error>[removed]</error> <muted>┄┄</muted><borderAccent>▶</borderAccent> gone            <borderMuted>│</borderMuted>",
		);
		assert.equal(
			lines[7],
			"<borderMuted>│</borderMuted>  <warning>│</warning> <warning><b>Parser</b></warning> <warning>[changed] │</warning>                <borderMuted>│</borderMuted>",
		);
		assert.equal(
			lines[8],
			"<borderMuted>│</borderMuted>  <warning>│ keeps order      │</warning>                <borderMuted>│</borderMuted>",
		);
		const key =
			"<success>■</success> <dim>new</dim>  <warning>■</warning> <dim>changed</dim>  <error>■</error> <dim>removed</dim>";
		assert.ok(lines.at(-1)!.includes(key), lines.at(-1));
	});

	it("leaves unmarked text alone", () => {
		const lines = renderDiagram({ title: "T", body: "╭─────╮\n│ API │\n╰─────╯" }, 40, tagTheme);
		assert.equal(
			lines[3],
			"<borderMuted>│</borderMuted>  <muted>│</muted> API <muted>│</muted>                             <borderMuted>│</borderMuted>",
		);
	});

	it("tidies a raw body before drawing it", () => {
		const lines = renderDiagram({ title: "T", body: "\n\t  A ──▶ B   \n" }, 30, plainTheme);
		assert.equal(lines[2], "│  A ──▶ B                   │");
	});
});

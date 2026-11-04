import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { editorTheme } from "../src/ui/inline-editor.ts";
import { meter } from "../src/ui/meter.ts";
import {
	box,
	clipLine,
	edge,
	fitLine,
	lineWidth,
	middleTruncate,
	paintLine,
	pathAfter,
	raw,
	sp,
	wrap,
	wrapAfter,
} from "../src/ui/spans.ts";
import { plainTheme, tagTheme } from "./helpers.ts";

const text = (line: ReturnType<typeof sp>[]) => paintLine(line, plainTheme);

describe("spans", () => {
	it("clip with an ellipsis, also inside styled text that came ready", () => {
		assert.equal(text(clipLine([sp("abcdefghi"), sp("jk")], 10)), "abcdefghi…");
		assert.equal(text(clipLine([sp("abc")], 5)), "abc");
		const cut = clipLine([sp("ab"), raw("\x1b[1mcdefgh\x1b[22m", "cdefgh")], 5);
		assert.equal(lineWidth(cut), 5);
		assert.ok(paintLine(cut, plainTheme).startsWith("ab\x1b[1mcd"));
		assert.equal(text(clipLine([sp("abcdef")], 0)), "");
		assert.equal(text(fitLine([sp("ab")], 4)), "ab  ");
	});

	it("wrap words, keep line breaks and break words that do not fit", () => {
		assert.deepEqual(wrap("one two three", 7), ["one two", "three"]);
		assert.deepEqual(wrap("a\n\nb", 5), ["a", "", "b"]);
		assert.deepEqual(wrap("abcdefghij xy", 4), ["abcd", "efgh", "ij", "xy"]);
		assert.deepEqual(wrap("x", 0), ["x"]);
		assert.deepEqual(
			wrapAfter([sp("+ ")], "one two", 5).map(text),
			["+ ", "one", "two"],
			"too little room after the prefix wraps under it",
		);
	});

	it("break a path that does not fit after a slash, not inside a name", () => {
		assert.deepEqual(wrap("in docs/plans/todo-item-mutations.md", 20), [
			"in",
			"docs/plans/",
			"todo-item-mutations.",
			"md",
		]);
		const lines = (path: string, total: number) =>
			pathAfter([sp("  Approving writes ")], path, total, "accent", 4).map(text);
		assert.deepEqual(lines("docs/plans/x.md", 40), ["  Approving writes docs/plans/x.md"]);
		assert.deepEqual(lines("docs/plans/todo-item-mutations.md", 40), [
			"  Approving writes ",
			"    docs/plans/todo-item-mutations.md",
		]);
		assert.deepEqual(lines("docs/plans/todo-item-mutations.md", 26), [
			"  Approving writes ",
			"    docs/plans/",
			"    todo-item-mutations.md",
		]);
		assert.deepEqual(lines("docs/plans/todo-item-mutations.md", 20), [
			"  Approving writes ",
			"    docs/plans/",
			"    todo-ite…ions.md",
		]);
		assert.equal(middleTruncate("abcdefghij", 5), "ab…ij");
		assert.equal(middleTruncate("abc", 5), "abc");
	});

	it("draw edges that drop labels when they do not fit", () => {
		assert.equal(text(edge(1, "round", "border", "top")), "╭");
		assert.equal(text(edge(12, "round", "border", "top", [sp("title")], [sp("right")])), "╭─ title ──╮");
		assert.equal(text(edge(8, "round", "border", "top", [sp("a long title")])), "╭─ a… ─╮");
		assert.equal(text(edge(6, "round", "border", "top", [sp("a long title")])), "╭────╮");
		assert.equal(text(edge(10, "light", "border", "bottom", [sp("a long title")])), "└─ a l… ─┘");
		assert.deepEqual(box([[sp("x")]], 6, { style: "heavy", color: "border" }).map(text), [
			"┏━━━━┓",
			"┃ x  ┃",
			"┗━━━━┛",
		]);
	});

	it("meters clamp and colour by level", () => {
		assert.equal(text(meter(9)), "▰▰▰▰▰");
		assert.equal(text(meter(-1)), "▱▱▱▱▱");
	});

	it("the editor theme paints with ours", () => {
		const theme = editorTheme(tagTheme);
		assert.equal(theme.borderColor("─"), "<borderAccent>─</borderAccent>");
		const list = theme.selectList;
		assert.deepEqual(
			[
				list.selectedPrefix("a"),
				list.selectedText("b"),
				list.description("c"),
				list.scrollInfo("d"),
				list.noMatch("e"),
			],
			["<accent>a</accent>", "<accent>b</accent>", "<muted>c</muted>", "<dim>d</dim>", "<warning>e</warning>"],
		);
	});
});

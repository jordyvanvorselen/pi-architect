import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ENTRY_TYPE, WIDGET_KEY } from "../src/index.ts";
import { event, type EventInput } from "../src/state/events.ts";
import { newArchitecture, rebuild } from "../src/state/reducer.ts";
import type { Architecture } from "../src/state/types.ts";
import {
	BOARD_SHORTCUT,
	BoardScreen,
	boardMessage,
	openBoard,
	paintMarkdownTheme,
	TABS,
	type BoardComment,
	type BoardData,
	type BoardTab,
} from "../src/ui/board/index.ts";
import { planBody, summarize } from "../src/ui/board/model.ts";
import { boardMargin, boardOverlay, hintRows, tabBar } from "../src/ui/board/screen.ts";
import { fullArchitecture } from "./fixtures/plan/architecture.ts";
import { harness, type BranchEntry } from "./harness.ts";
import { ansiTheme, FakeUi, KEYS, plain, plainTheme, tagTheme, type } from "./helpers.ts";

/** The fixture architecture, back in the Slice phase and not approved. */
function sliceArch(partial: Partial<Architecture> = {}): Architecture {
	const arch = fullArchitecture();
	delete arch.approvedAt;
	return { ...arch, phase: "slice", status: "working", ...partial };
}

/** A diagram wider than a narrow board. */
const WIDE = {
	id: "g9",
	phase: "design" as const,
	title: "Wide flow",
	body: `┌──────┐${"─".repeat(60)}┌──────┐\n│ left │${" ".repeat(60)}│ right│\n└──────┘${"─".repeat(60)}└──────┘`,
	caption: "A long way across.",
};

interface Fixture {
	screen: BoardScreen;
	/** The comments the board closed with, once it closed. */
	closed(): BoardComment[] | undefined;
	set(data: BoardData): void;
	/** Plain lines at a width. */
	lines(width?: number): string[];
	press(...keys: string[]): void;
	renders(): number;
	tui: { terminal: { rows: number; columns: number } };
}

function board(
	data: BoardData,
	options: { rows?: number; columns?: number; tab?: BoardTab; paint?: typeof plainTheme } = {},
): Fixture {
	let current = data;
	let closed: BoardComment[] | undefined;
	let renders = 0;
	const tui = {
		requestRender: () => renders++,
		terminal: { rows: options.rows ?? 40, columns: options.columns ?? 100 },
	};
	const paint = options.paint ?? plainTheme;
	const screen = new BoardScreen(tui as never, paint, {
		data: () => current,
		markdown: paintMarkdownTheme(paint),
		...(options.tab ? { tab: options.tab } : {}),
		done: (comments) => (closed = comments),
	});
	screen.focused = true;
	const width = options.columns ?? 100;
	const fixture: Fixture = {
		screen,
		closed: () => closed,
		set: (next) => {
			current = next;
			screen.update();
		},
		lines: (w = width) => plain(screen.render(w)),
		press: (...keys) => {
			for (const key of keys) {
				screen.render(width);
				screen.handleInput(key);
			}
			screen.render(width);
		},
		renders: () => renders,
		tui,
	};
	fixture.lines();
	return fixture;
}

const architect = (arch: Architecture = sliceArch()): BoardData => ({
	mode: "architect",
	arch,
	planTarget: "docs/plans/dedupe-panel-events.md",
});

function click(x: number, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 100,
		height: 38,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
		...extra,
	};
}

/** Row and column of the first line that contains `text`. */
function find(lines: string[], text: string): { x: number; y: number } {
	const y = lines.findIndex((l) => l.includes(text));
	assert.ok(y >= 0, `no line with ${JSON.stringify(text)}`);
	return { x: [...lines[y]!.slice(0, lines[y]!.indexOf(text))].length, y };
}

describe("board tabs", () => {
	it("opens on the tab of the current phase, or on the plan once approved", () => {
		assert.equal(board(architect()).screen.state.tab, "slices");
		assert.equal(board(architect(sliceArch({ phase: "decide" }))).screen.state.tab, "decisions");
		assert.equal(board(architect(sliceArch({ phase: "frame" }))).screen.state.tab, "brief");
		assert.equal(board(architect(sliceArch({ phase: "explore" }))).screen.state.tab, "explore");
		assert.equal(board(architect(sliceArch({ phase: "design" }))).screen.state.tab, "diagrams");
		assert.equal(board(architect(sliceArch({ phase: "blueprint" }))).screen.state.tab, "plan");
		assert.equal(board(architect(fullArchitecture())).screen.state.tab, "plan");
		assert.equal(board({ mode: "build" }).screen.state.tab, "plan");
		assert.equal(board(architect(), { tab: "risks" }).screen.state.tab, "risks");
	});

	it("switches with 1–7, tab and shift+tab, and ←/→, wrapping at the ends", () => {
		const b = board(architect(), { tab: "brief" });
		b.press("3");
		assert.equal(b.screen.state.tab, "decisions");
		b.press(KEYS.tab);
		assert.equal(b.screen.state.tab, "diagrams");
		b.press(KEYS.shiftTab, KEYS.shiftTab);
		assert.equal(b.screen.state.tab, "explore");
		b.press(KEYS.left, KEYS.left);
		assert.equal(b.screen.state.tab, "plan");
		b.press(KEYS.right);
		assert.equal(b.screen.state.tab, "brief");
		b.press("7", "7");
		assert.equal(b.screen.state.tab, "plan");
	});

	it("shows counts and states in the tab bar, and shortens the labels as the width shrinks", () => {
		const arch = sliceArch({
			phase: "decide",
			decisions: [...sliceArch().decisions, { id: "q3", question: "Open?", options: [] }],
		});
		const at = (width: number) => board(architect(arch), { columns: width }).lines(width)[2]!;
		assert.match(
			at(120),
			/^│ {2}Brief {3}Explore 7 {3}● Decisions 3 \(1 open\) {3}Diagrams 3 {3}Risks 3 \(1 high\) {3}Slices 4 {3}Plan draft/,
		);
		assert.match(at(80), /│ {2}Brief {2}Explore 7 {2}● Decisions 3 {2}Diagrams 3 {2}Risks 3 {2}Slices 4 {2}Plan/);
		assert.match(at(100), /● Decisions 3 \(1 open\) {2}Diagrams 3 {2}Risks 3 \(1 high\) {2}Slices 4/);
		assert.match(at(60), /Brf {2}Exp 7 {2}● Decisions 3 {2}Dgm 3 {2}Rsk 3 {2}Slc 4 {2}Pln/);
		assert.match(at(40), /│ Brf Exp Dec 3 Dgm Rsk Slc Pln/);
		assert.match(at(30), /│ 1 2 Dec 3 4 5 6 7/);
		assert.equal(at(12).length, 12);
	});

	it("colours the active tab in accent with a heavy rule under it, and tabs not reached yet dim", () => {
		const arch = sliceArch({ phase: "decide", status: "review" });
		const b = board(architect(arch), { paint: tagTheme, columns: 120 });
		const lines = b.screen.render(120);
		const bar = lines.find((l) => l.includes("Decisions"))!;
		assert.match(bar, /<warning>◉ <\/warning><accent><b>Decisions<\/b><\/accent><accent> 2<\/accent>/);
		assert.match(bar, /<text>Explore<\/text><muted> 7<\/muted>/);
		assert.match(bar, /<dim>Slices<\/dim><dim> 4<\/dim>/);
		assert.match(bar, /<error>\(1 high\)<\/error>/);
		const rule = lines[lines.indexOf(bar) + 1]!;
		assert.match(rule, /<border>├─+<\/border><accent>━{15}<\/accent><border>─+┤<\/border>/);
		assert.match(lines[1]!, /<warning>◉ awaiting your review<\/warning>/);
		b.press("c", ...type("ok"), KEYS.enter);
		assert.match(
			b.screen.render(120).find((l) => l.includes("Decisions"))!,
			/<warning> ✎1<\/warning>/,
		);
	});

	it("dims an unreached tab's note and says when its phase comes", () => {
		const arch = { ...newArchitecture(1, "Dedupe", "dedupe"), phase: "explore" as const };
		const b = board(architect(arch));
		for (const [key, title, when] of [
			["3", "Decisions", "Comes in Decide · phase 3 of 6 · now Explore"],
			["4", "Diagrams", "Comes in Design · phase 4 of 6 · now Explore"],
			["6", "Slices", "Comes in Slice · phase 5 of 6 · now Explore"],
		] as const) {
			b.press(key);
			const text = b.lines().join("\n");
			assert.match(text, new RegExp(`○ {2}${title}`));
			assert.ok(text.includes(when), when);
		}
		b.press("2");
		assert.match(b.lines().join("\n"), /The module map appears here/);
		b.press("5");
		assert.match(b.lines().join("\n"), /○ {2}Risks[\s\S]*none yet/);
		const decided = board(architect({ ...arch, phase: "design" }), { tab: "decisions" });
		assert.match(decided.lines().join("\n"), /none raised[\s\S]*No open questions/);
		const tags = board(architect(arch), { paint: tagTheme, tab: "brief" }).screen.render(100);
		assert.ok(tags.some((l) => l.includes("<dim>Slices</dim>")));
	});

	it("explains each tab in a session that only builds from a plan file", () => {
		const data: BoardData = {
			mode: "build",
			plan: { path: "docs/plans/dedupe.md", feature: "Dedupe", slug: "dedupe", at: 1 },
			planText: "---\nfeature: Dedupe\n---\n\n# Dedupe\n\n## Slices\n",
		};
		const b = board(data);
		const text = b.lines().join("\n");
		assert.match(text, /◆ Board {2}Dedupe/);
		assert.match(text, /▣ Approved plan {2}docs\/plans\/dedupe\.md/);
		assert.match(text, /read-only/);
		b.press("1");
		assert.match(b.lines().join("\n"), /This session builds from docs\/plans\/dedupe\.md/);
		const { planText: _text, ...noText } = data;
		const missing = board(noText);
		assert.match(missing.lines().join("\n"), /file not found[\s\S]*\/architect plan[\s\S]*write writes it again/);
		const none = board({ mode: "build" });
		assert.match(none.lines().join("\n"), /The plan appears here/);
		none.press("2");
		assert.match(none.lines().join("\n"), /There is no architecture in this session/);
	});
});

describe("board scrolling and items", () => {
	it("moves between items with ↑/↓ and j/k, and scrolls through an item taller than the view", () => {
		const b = board(architect(), { tab: "decisions", rows: 16, columns: 80 });
		assert.equal(b.screen.state.selected, "decision:q1");
		b.press("j");
		assert.equal(b.screen.state.selected, "decision:q2");
		b.press(KEYS.enter);
		assert.deepEqual(b.screen.state.expanded, ["decision:q2"]);
		const before = b.screen.state.scroll;
		b.press(KEYS.down, KEYS.down, KEYS.down);
		assert.equal(b.screen.state.selected, "decision:q2", "stays on the long item while it scrolls");
		assert.ok(b.screen.state.scroll > before);
		b.press(KEYS.end, ...Array<string>(20).fill(KEYS.down));
		const bottom = b.screen.state.scroll;
		b.press(KEYS.down);
		assert.equal(b.screen.state.scroll, bottom, "the end does not move");
		b.press("k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k", "k");
		assert.equal(b.screen.state.selected, "decision:q1");
		assert.equal(b.screen.state.scroll, 0);
		b.press(KEYS.up);
		assert.equal(b.screen.state.scroll, 0);
	});

	it("pages with PgUp/PgDn and space, jumps with Home/End and g/G, and keeps a selection in view", () => {
		const b = board(architect(), { tab: "slices", rows: 14, columns: 80 });
		b.press("e");
		b.press(KEYS.pageDown);
		const paged = b.screen.state.scroll;
		assert.ok(paged > 0);
		assert.equal(b.screen.state.selected, "slice:s1", "kept while it is in view");
		b.press(KEYS.pageDown);
		assert.notEqual(b.screen.state.selected, "slice:s1");
		b.press(" ");
		assert.ok(b.screen.state.scroll > paged);
		b.press(KEYS.pageUp, KEYS.pageUp, KEYS.pageUp);
		assert.equal(b.screen.state.scroll, 0);
		b.press("G");
		assert.equal(b.screen.state.selected, "slice:s4");
		b.press("g");
		assert.equal(b.screen.state.selected, "slice:s1");
		assert.equal(b.screen.state.scroll, 0);
		b.press(KEYS.end);
		assert.equal(b.screen.state.selected, "slice:s4");
		b.press(KEYS.home);
		assert.equal(b.screen.state.selected, "slice:s1");
	});

	it("shows a scrollbar on the right border and how much is above and below", () => {
		const b = board(architect(), { tab: "plan", rows: 20, columns: 80 });
		let lines = b.lines(80);
		assert.match(lines.at(-1)!, /↓ \d+ more ─╯$/);
		assert.ok(lines.slice(4, 10).some((l) => l.endsWith("┃")));
		b.press(KEYS.pageDown);
		lines = b.lines(80);
		assert.match(lines.at(-1)!, /↑ \d+ · ↓ \d+ more ─╯$/);
	});

	it("opens a decision into option cards with meters, and folds every one with e", () => {
		const b = board(architect(), { tab: "decisions", columns: 100 });
		b.press(KEYS.enter);
		const text = b.lines().join("\n");
		assert.match(text, /┏━ A {2}In the processor ★ ━+┓/);
		assert.match(text, /effort ▰▰▱▱▱/);
		assert.match(text, /★ Agent recommends A {2}In the processor/);
		assert.match(text, /✓ You chose A {2}In the processor/);
		assert.match(text, /"Yes, and log every skipped duplicate at debug level\."/);
		b.press("e");
		assert.deepEqual(b.screen.state.expanded.sort(), ["decision:q1", "decision:q2"]);
		b.press("e");
		assert.deepEqual(b.screen.state.expanded, []);
		const { chosen: _chosen, ...unanswered } = sliceArch().decisions[1]!;
		const open = sliceArch({ phase: "decide", decisions: [unanswered] });
		const o = board(architect(open), { tab: "decisions" });
		o.press(KEYS.enter);
		assert.match(o.lines().join("\n"), /○ open · the agent asks you on a decision card/);
		o.press("e");
		assert.deepEqual(o.screen.state.expanded, []);
		const brief = board(architect(), { tab: "brief" });
		brief.press("e", KEYS.enter);
		assert.deepEqual(brief.screen.state.expanded, [], "brief fields do not open");
	});

	it("opens a slice into its files, steps and verify commands, with build progress", () => {
		const progress = [
			{ number: 1, title: "a", total: 3, checked: 3 },
			{ number: 2, title: "b", total: 4, checked: 1 },
		];
		const b = board({ ...architect(fullArchitecture()), mode: "build", progress }, { tab: "slices" });
		let text = b.lines().join("\n");
		assert.match(text, /Slices 4 \(1\/2 done\)/);
		assert.match(text, /✓ 1 {2}Add the dedup key column {2,}3\/3/);
		assert.match(text, /● 2 {2}Build the dedup key {2,}← 1 {3}1\/4/);
		assert.match(text, /STEP 2 {2,}2 in parallel/);
		assert.match(text, /1 file · 2 steps · 2 checks/);
		b.press(KEYS.enter);
		text = b.lines().join("\n");
		assert.match(text, /files {3}migrations\//);
		assert.match(text, /steps {3}1\. /);
		assert.match(text, /verify {2}\$ /);
		const missing = sliceArch({ slices: [{ ...sliceArch().slices[0]!, verify: [], dependsOn: ["zz"] }] });
		const m = board(architect(missing), { tab: "slices" });
		m.press(KEYS.enter);
		assert.match(m.lines().join("\n"), /✗ s1 depends on unknown slice zz[\s\S]*verify {2}missing/);
	});

	it("shows the brief, the module map and findings, the risks by severity, and the plan draft", () => {
		const b = board(architect(), { tab: "brief" });
		let text = b.lines().join("\n");
		assert.match(text, /GOAL[\s\S]*CONSTRAINTS {2,}2[\s\S]*OUT OF SCOPE[\s\S]*× Changing the panel firmware/);
		assert.match(text, /☐ The alarm list shows one alarm per incident\./);
		b.press("2");
		text = b.lines().join("\n");
		assert.match(text, /MODULES {2,}● touched {2}\+ new {2}○ context/);
		assert.match(text, /FINDINGS {2,}3[\s\S]*f1 {2}Panels retry/);
		b.press("5");
		text = b.lines().join("\n");
		assert.match(text, /▰▰▰ 1 high {3}▰▰▱ 1 medium {3}▰▱▱ 1 low/);
		assert.match(text, /r1 {2}▰▰▰ high {3}Old v1 panels[\s\S]*↳ Skip the dedup key/);
		b.press("7");
		text = b.lines().join("\n");
		assert.match(text, /▢ Draft {2}not written yet/);
		assert.match(text, /Approving the Blueprint writes docs\/plans\/dedupe-panel-events\.md/);
		assert.match(text, /How to build this plan/);
		assert.doesNotMatch(text, /^│\s+feature:/m, "no front matter");
		const unset = board(
			architect({ ...sliceArch(), brief: { goal: "", constraints: [], outOfScope: [], doneWhen: [] } }),
			{
				tab: "brief",
			},
		);
		assert.match(unset.lines().join("\n"), /not set yet[\s\S]*none/);
	});

	it("shows a plan file that is written, approved", () => {
		const b = board({
			...architect(fullArchitecture()),
			plan: { path: "docs/plans/x.md", feature: "Dedupe panel events", slug: "x", at: 1 },
			planText: "# From the file\n\nhello",
		});
		const text = b.lines().join("\n");
		assert.match(text, /▣ Approved plan {2}docs\/plans\/x\.md/);
		assert.match(text, /From the file/);
		assert.match(text, /Plan written/);
		assert.match(text, /✓ plan approved/);
		const written = board(
			{
				...architect(),
				plan: { path: "docs/plans/x.md", feature: "f", slug: "x", at: 1 },
				planText: "# Hi",
				tab: undefined,
			} as BoardData,
			{ tab: "plan" },
		);
		assert.match(written.lines().join("\n"), /▣ Plan file {2}docs\/plans\/x\.md/);
		assert.equal(planBody("---\na: 1\n---\n\n# T\n"), "# T\n");
	});
});

describe("board diagrams", () => {
	it("lists every diagram as a card, grouped by phase, and opens one in a detail view", () => {
		const b = board(architect(), { tab: "diagrams" });
		let text = b.lines().join("\n");
		assert.match(text, /CURRENT SHAPE {2,}1 diagram[\s\S]*╭─ g1 Ingest today/);
		assert.match(text, /DESIGN {2,}2 diagrams/);
		b.press(KEYS.down, KEYS.enter);
		assert.equal(b.screen.state.detail, "diagram:g2");
		text = b.lines().join("\n");
		assert.match(text, /◂ Diagrams {2}\/ {2}g2 {2}Ingest with dedup/);
		assert.match(text, /←→ scroll sideways {2}↑↓ scroll {2}c comment {2}esc back/);
		b.press(KEYS.escape);
		assert.equal(b.screen.state.detail, undefined);
		assert.equal(b.screen.state.selected, "diagram:g2");
		b.press(KEYS.enter, "q");
		assert.equal(b.screen.state.detail, undefined, "q steps back too");
		b.press(KEYS.enter, "\x7f");
		assert.equal(b.screen.state.detail, undefined, "and backspace");
		assert.equal(b.closed(), undefined);
	});

	it("scrolls a wide diagram sideways with ←/→ and up and down with ↑/↓ in the detail view", () => {
		const arch = sliceArch({ diagrams: [WIDE] });
		const b = board(architect(arch), { tab: "diagrams", columns: 40, rows: 16 });
		assert.match(b.lines(40).join("\n"), /76 cols · the full view with ↵/);
		b.press(KEYS.enter);
		assert.equal(b.screen.state.detailScroll, 0);
		b.press(KEYS.right, KEYS.right);
		assert.equal(b.screen.state.detailScroll, 16);
		b.press(KEYS.left);
		assert.equal(b.screen.state.detailScroll, 8);
		b.press("$");
		assert.ok(b.screen.state.detailScroll! > 16);
		b.press("0");
		assert.equal(b.screen.state.detailScroll, 0);
		b.press(KEYS.down);
		assert.equal(b.screen.state.scroll, 1);
		b.press(KEYS.right, KEYS.end);
		assert.equal(b.screen.state.scroll, 2);
		assert.match(b.lines(40).join("\n"), /◀ cols 9–/);
		b.press(KEYS.home);
		assert.equal(b.screen.state.scroll, 0);
		b.press(KEYS.up);
		assert.equal(b.screen.state.scroll, 0);
		b.press(KEYS.tab);
		assert.equal(b.screen.state.tab, "risks");
		assert.equal(b.screen.state.detail, undefined);
	});

	it("closes the detail view when the diagram goes away", () => {
		const b = board(architect(), { tab: "diagrams" });
		b.press(KEYS.enter);
		assert.equal(b.screen.state.detail, "diagram:g1");
		b.set(architect(sliceArch({ diagrams: [] })));
		assert.equal(b.screen.state.detail, undefined);
	});
});

describe("board comments", () => {
	it("writes a comment on the selected item and sends every comment on close", () => {
		const b = board(architect(), { tab: "decisions" });
		b.press(KEYS.down, "c");
		assert.equal(b.screen.state.editing, "decision:q2");
		let text = b.lines().join("\n");
		assert.match(text, /├─ ✎ Comment on q2 {2}How long do dedup keys stay unique\? ─+┤/);
		assert.match(text, /↵ save {2}shift\+↵ new line {2}esc cancel/);
		b.press(...type("Per day is fine"), KEYS.enter);
		assert.equal(b.screen.state.editing, undefined);
		text = b.lines().join("\n");
		assert.match(text, /┃ ✎ Per day is fine/);
		assert.match(text, /✎ 1 to send/);
		assert.match(text, /Decisions 2 ✎1/);
		assert.match(text, /╰─ ✎ q2 ─/);
		assert.match(text, /c edit comment {2}x remove {2}m next comment {2}esc close · 1 to send/);
		b.press("6", "c", ...type("Split it"), KEYS.enter, "1", "c", ...type("Tighter"), KEYS.enter);
		b.press(KEYS.escape, KEYS.enter);
		assert.deepEqual(
			b.closed()!.map((c) => [c.tab, c.ref, c.label, c.text]),
			[
				["decisions", "q2", "How long do dedup keys stay unique?", "Per day is fine"],
				["slices", "slice 1", "Add the dedup key column", "Split it"],
				["brief", "brief goal", undefined, "Tighter"],
			],
		);
		b.press(KEYS.escape);
		assert.equal(b.closed()!.length, 3, "closes once");
	});

	it("asks before closing with comments: ↵ sends them, d discards them, esc keeps editing", () => {
		const b = board(architect(), { tab: "risks" });
		b.press("c", ...type("watch this"), KEYS.enter, "q");
		assert.equal(b.screen.state.confirming, true);
		assert.equal(b.closed(), undefined);
		let text = b.lines().join("\n");
		assert.match(text, /│ +Send 1 comment to the agent\? {2}↵ send {2}d discard {2}esc keep editing +│/);
		assert.doesNotMatch(text, /1-7 tabs/);
		b.press("c", "x", "m", KEYS.down, "q");
		assert.deepEqual(
			[b.screen.state.editing, b.screen.state.selected, b.screen.state.comments.length],
			[undefined, "risk:r1", 1],
			"other keys do nothing",
		);
		b.screen.handleMouse(click(5, 1));
		assert.equal(b.screen.state.confirming, true, "clicks do nothing");
		b.press(KEYS.escape);
		assert.equal(b.screen.state.confirming, false);
		assert.equal(b.closed(), undefined);
		text = b.lines().join("\n");
		assert.match(text, /esc close · 1 to send/);
		b.press(KEYS.down, "c", ...type("and this"), KEYS.enter, KEYS.escape);
		assert.match(b.lines().join("\n"), /Send 2 comments to the agent\?/);
		b.press("d");
		assert.deepEqual(b.closed(), [], "d discards");
		b.press(KEYS.enter);
		assert.deepEqual(b.closed(), [], "closes once");

		const sent = board(architect(), { tab: "risks" });
		sent.press("c", "y", KEYS.enter, KEYS.escape, KEYS.enter);
		assert.deepEqual(
			sent.closed()!.map((c) => c.text),
			["y"],
		);
	});

	it("shortens the send question on narrow boards", () => {
		const at = (columns: number) => {
			const b = board(architect(), { tab: "risks", columns });
			b.press("c", "y", KEYS.enter, KEYS.down, "c", "z", KEYS.enter, "q");
			return b.lines().join("\n");
		};
		assert.match(at(100), /Send 2 comments to the agent\? {2}↵ send {2}d discard {2}esc keep editing/);
		assert.match(at(50), /Send 2 comments\? {2}↵ send {2}d discard {2}esc back/);
		assert.match(at(40), /│ Send 2\? {2}↵ send {2}d discard {2}esc back +│/);
		assert.match(at(30), /│ Send 2\? {2}↵ {2}d {2}esc +│/);
	});

	it("edits a comment, removes it with x or by saving it empty, and cancels with esc", () => {
		const b = board(architect(), { tab: "risks" });
		b.press("c", ...type("watch this"), KEYS.escape);
		assert.equal(b.screen.state.comments.length, 0, "esc cancels");
		assert.equal(b.screen.focused, true);
		b.press("c");
		b.screen.focused = false;
		assert.equal(b.screen.focused, false);
		b.screen.focused = true;
		b.press(KEYS.escape);
		b.press("c", ...type("watch this"), KEYS.enter);
		b.press("c");
		assert.match(b.lines().join("\n"), /↵ save · empty removes/);
		b.press(...type(" closely"), KEYS.enter);
		assert.equal(b.screen.state.comments[0]!.text, "watch this closely");
		b.press("x");
		assert.equal(b.screen.state.comments.length, 0);
		b.press("x");
		b.press("c", ...type("again"), KEYS.enter, "c");
		for (let i = 0; i < 6; i++) b.press("\x7f");
		b.press(KEYS.enter);
		assert.equal(b.screen.state.comments.length, 0, "an empty save removes it");
		b.press("q");
		assert.deepEqual(b.closed(), []);
	});

	it("jumps from comment to comment with m, across tabs", () => {
		const b = board(architect(), { tab: "risks" });
		b.press("m");
		b.press(KEYS.down, KEYS.down, "c", ...type("r3!"), KEYS.enter, "4", "c", ...type("d!"), KEYS.enter, "1");
		b.press("m");
		assert.deepEqual([b.screen.state.tab, b.screen.state.selected], ["risks", "risk:r3"]);
		b.press("m");
		assert.deepEqual([b.screen.state.tab, b.screen.state.selected], ["diagrams", "diagram:g1"]);
		b.press("m");
		assert.deepEqual([b.screen.state.tab, b.screen.state.selected], ["risks", "risk:r3"]);
	});

	it("comments on a diagram from its detail view", () => {
		const b = board(architect(), { tab: "diagrams" });
		b.press(KEYS.enter, "c", ...type("add the queue"), KEYS.enter);
		assert.match(b.lines().join("\n"), /✎ add the queue/);
		assert.equal(b.screen.state.detail, "diagram:g1");
		b.press(KEYS.escape, KEYS.escape, KEYS.enter);
		assert.deepEqual(
			b.closed()!.map((c) => c.ref),
			["g1"],
		);
	});

	it("is read-only in build mode: no comments, and nothing to send", () => {
		const b = board({ ...architect(fullArchitecture()), mode: "build" }, { tab: "decisions" });
		b.press("c", "x", "m");
		assert.equal(b.screen.state.editing, undefined);
		const text = b.lines().join("\n");
		assert.match(text, /read-only/);
		assert.doesNotMatch(text, /comment/);
		b.press(KEYS.enter);
		assert.deepEqual(b.screen.state.expanded, ["decision:q1"], "reading still works");
		b.press(KEYS.escape);
		assert.deepEqual(b.closed(), []);
	});

	it("formats the comments as one message with item references", () => {
		assert.equal(
			boardMessage([
				{ tab: "decisions", key: "decision:q2", ref: "q2", label: 'Keys "unique"?', text: "per day\nbut UTC" },
				{ tab: "brief", key: "brief:goal", ref: "brief goal", text: " tighter " },
			]),
			"Board comments:\n- q2 \"Keys 'unique'?\": per day\n  but UTC\n- brief goal: tighter",
		);
	});
});

describe("board mouse", () => {
	it("switches tabs with a click on a label", () => {
		const b = board(architect(), { tab: "brief" });
		const at = find(b.lines(), "Risks 3");
		assert.deepEqual(b.screen.handleMouse(click(at.x + 1, at.y)), { handled: true });
		assert.equal(b.screen.state.tab, "risks");
		b.screen.handleMouse(click(1, at.y));
		assert.equal(b.screen.state.tab, "risks", "a click between labels does nothing");
	});

	it("selects an item with a click and opens it with a second click or a double click", () => {
		const b = board(architect(), { tab: "decisions" });
		const q2 = find(b.lines(), "q2  How long");
		b.screen.handleMouse(click(q2.x, q2.y));
		assert.equal(b.screen.state.selected, "decision:q2");
		assert.deepEqual(b.screen.state.expanded, []);
		b.screen.handleMouse(click(q2.x, q2.y));
		assert.deepEqual(b.screen.state.expanded, ["decision:q2"]);
		const q1 = find(b.lines(), "q1  Where");
		b.screen.handleMouse(click(q1.x, q1.y, { clickCount: 2 }));
		assert.deepEqual(b.screen.state.expanded.sort(), ["decision:q1", "decision:q2"]);
		const lines = b.lines();
		b.screen.handleMouse(
			click(
				4,
				lines.findIndex((l, i) => i > 4 && /^│\s+│$/.test(l)),
			),
		);
		b.screen.handleMouse(click(4, 1000));
		assert.deepEqual(b.screen.state.expanded.sort(), ["decision:q1", "decision:q2"], "blank lines do nothing");
	});

	it("scrolls with the wheel, sideways with shift in the detail view", () => {
		const b = board(architect(), { tab: "plan", rows: 20 });
		b.screen.handleMouse({ ...click(10, 10), type: "wheel", wheelDelta: 1 });
		b.lines();
		assert.equal(b.screen.state.scroll, 3);
		b.screen.handleMouse({ ...click(10, 10), type: "wheel", wheelDelta: -1 });
		b.lines();
		assert.equal(b.screen.state.scroll, 0);
		const d = board(architect(sliceArch({ diagrams: [WIDE] })), { tab: "diagrams", columns: 40, rows: 14 });
		d.press(KEYS.enter);
		d.screen.handleMouse({ ...click(10, 6), type: "wheel", wheelDelta: 1, shift: true });
		assert.equal(d.screen.state.detailScroll, 8);
		d.screen.handleMouse({ ...click(10, 6), type: "wheel", wheelDelta: -1, shift: true });
		assert.equal(d.screen.state.detailScroll, 0);
		d.screen.handleMouse({ ...click(10, 6), type: "wheel" });
		assert.equal(d.screen.state.scroll, 0);
	});

	it("jumps to a comment from the bottom edge, and ignores other buttons, presses and clicks while writing", () => {
		const b = board(architect(), { tab: "risks" });
		b.press("c", ...type("r1!"), KEYS.enter, "2");
		const lines = b.lines();
		const ref = find(lines, "✎ r1");
		assert.equal(ref.y, lines.length - 1);
		b.screen.handleMouse(click(ref.x + 2, ref.y));
		assert.deepEqual([b.screen.state.tab, b.screen.state.selected], ["risks", "risk:r1"]);
		b.press("2");
		b.screen.handleMouse(click(60, ref.y));
		assert.equal(b.screen.state.tab, "explore");
		assert.deepEqual(b.screen.handleMouse({ ...click(10, 2), button: "right" }), { handled: true, render: false });
		assert.deepEqual(b.screen.handleMouse({ ...click(10, 2), type: "press" }), { handled: true, render: false });
		b.press("c");
		b.screen.handleMouse(click(find(b.lines(), "Risks").x, find(b.lines(), "Risks").y));
		assert.equal(b.screen.state.tab, "explore");
		b.press(KEYS.escape, KEYS.escape, "d");
		assert.equal(b.screen.handleMouse(click(1, 1)), undefined, "closed");
		b.screen.handleInput("1");
		assert.equal(b.screen.state.tab, "explore");
	});
});

describe("board layout", () => {
	it("keeps the plan path whole on a 60-column Plan tab, on its own line when it must", () => {
		const data = { ...architect(), planTarget: "docs/plans/todo-item-mutations.md" };
		const text = board(data, { columns: 60, rows: 30, tab: "plan" }).lines().join("\n");
		assert.match(text, /Approving the Blueprint writes +[│┃]\n│ +docs\/plans\/todo-item-mutations\.md +[│┃]/);
		const written = board(
			{
				...data,
				plan: { path: "docs/plans/todo-item-mutations-for-every-panel.md", feature: "x", slug: "x", at: 1 },
				planText: "# Plan\n",
			},
			{ columns: 60, rows: 30, tab: "plan" },
		);
		assert.match(
			written.lines().join("\n"),
			/Plan file +[│┃]\n│ +docs\/plans\/todo-item-mutations-for-every-panel\.md/,
		);
	});

	it("fits every line on every tab at widths 30 to 200 and heights 10 to 40, with the height it has", () => {
		const data = architect(sliceArch({ diagrams: [...sliceArch().diagrams, WIDE] }));
		for (const columns of [30, 40, 80, 120, 200])
			for (const rows of [10, 15, 30, 40]) {
				const b = board(data, { columns, rows, paint: ansiTheme });
				const m = boardMargin(columns, rows);
				for (const tab of TABS) {
					b.press(String(TABS.indexOf(tab) + 1), "e");
					for (const state of ["browse", "open", "comment"] as const) {
						if (state === "open") b.press(KEYS.enter);
						if (state === "comment") b.press("c", ...type("a comment that is long enough to wrap"));
						const lines = b.screen.render(columns);
						assert.equal(lines.length, rows - m.top - m.bottom, `${tab} ${state} at ${columns}x${rows}`);
						for (const line of lines)
							assert.ok(
								visibleWidth(line) <= columns,
								`${tab} ${state} at ${columns}x${rows}: ${visibleWidth(line)} wide: ${plain([line])[0]}`,
							);
					}
					b.press(KEYS.enter, KEYS.escape, KEYS.escape);
				}
			}
	});

	it("keeps the phases row on tall terminals only, and shortens the key hints on narrow ones", () => {
		const tall = board(architect(), { rows: 30 }).lines();
		assert.match(tall[1]!, /✓ Frame ━━ ✓ Explore/);
		const short = board(architect(), { rows: 12 }).lines();
		assert.match(short[1]!, /Brief/);
		const narrow = board(architect(), { columns: 30, rows: 10, tab: "slices" }).lines(30);
		assert.match(narrow.at(-2)!, /│ ↑↓ {2}↵ {2}c {2}esc {2,}│/);
		assert.deepEqual(hintRows([[["a", "b"]]], 1, 1).length, 1);
		assert.deepEqual(hintRows([], 10, 1), []);
	});

	it("follows resizes and theme changes, and redraws live when the data changes", () => {
		const b = board(architect(), { tab: "risks" });
		assert.equal(b.lines().length, 40);
		b.tui.terminal.rows = 20;
		assert.equal(b.lines().length, 20);
		assert.equal(b.lines(60)[0]!.length, 60);
		let accent = "accent";
		const theme = { fg: (c: string, t: string) => `<${c === "accent" ? accent : c}>${t}</>`, bold: (t: string) => t };
		const t = board(architect(), { paint: theme, tab: "risks" });
		assert.match(t.screen.render(100).join(""), /<accent>Risks/);
		accent = "pink";
		t.screen.invalidate();
		assert.match(t.screen.render(100).join(""), /<pink>Risks/);
		const renders = b.renders();
		b.press("c", ...type("x"), KEYS.enter);
		b.set(architect(sliceArch({ risks: [...sliceArch().risks, { id: "r4", text: "New one", severity: "high" }] })));
		assert.ok(b.renders() > renders);
		assert.match(b.lines().join("\n"), /r4 {2}▰▰▰ high {3}New one/);
		assert.equal(b.screen.state.comments.length, 1, "comments survive an update");
	});

	it("covers the whole terminal", () => {
		assert.deepEqual(boardOverlay(120, 40), {
			anchor: "center",
			width: "100%",
			maxHeight: "100%",
			margin: { top: 0, bottom: 0, left: 0, right: 0 },
		});
	});

	it("drops tabs that do not fit even as numbers", () => {
		const summaries = Object.fromEntries(TABS.map((t) => [t, summarize({ mode: "architect" }, t)])) as Parameters<
			typeof tabBar
		>[0];
		const bar = tabBar(summaries, "brief", {}, 5);
		assert.ok(bar.ranges.every((r) => r.end <= 5));
	});
});

describe("openBoard", () => {
	const ctx = (ui: FakeUi | undefined, idle = true, mode = "tui") =>
		({
			hasUI: Boolean(ui),
			mode,
			ui: ui ?? { notify: () => {}, theme: plainTheme },
			isIdle: () => idle,
		}) as never;

	it("needs Pi's terminal and something to show", async () => {
		const ui = new FakeUi();
		const send = () => assert.fail("nothing to send");
		assert.equal(await openBoard(ctx(ui, true, "rpc"), { data: () => architect(), send }), undefined);
		assert.equal(await openBoard(ctx(ui), { data: () => ({ mode: "architect" }), send }), undefined);
		assert.deepEqual(
			ui.notifications.map((n) => n.message),
			[
				"The board needs Pi's interactive terminal. /architect plan shows the plan.",
				"There is no architecture to show yet. /architect <feature> starts one.",
			],
		);
	});

	it("sends the comments at once when the agent is idle, and steers them in when it is busy", async () => {
		for (const idle of [true, false]) {
			const ui = new FakeUi().keys(["c", ...type("Tighter"), KEYS.enter, KEYS.escape, KEYS.enter]);
			const sent: { text: string; options: unknown }[] = [];
			const opened: unknown[] = [];
			const comments = await openBoard(ctx(ui, idle), {
				data: () => architect(),
				send: (text, options) => sent.push({ text, options }),
				markdown: paintMarkdownTheme(plainTheme),
				tab: "brief",
				onOpen: (b) => opened.push(b),
			});
			assert.equal(comments!.length, 1);
			assert.deepEqual(sent, [
				{ text: "Board comments:\n- brief goal: Tighter", options: idle ? undefined : { deliverAs: "steer" } },
			]);
			assert.equal(
				ui.notifications.at(-1)!.message,
				idle ? "Sent 1 board comment to the agent." : "Queued 1 board comment for the agent's next step.",
			);
			assert.ok(opened[0] instanceof BoardScreen);
			assert.equal(opened[1], undefined);
			const options = ui.customs[0]!.options as { overlay: boolean; overlayOptions: () => unknown };
			assert.equal(options.overlay, true);
			assert.deepEqual(options.overlayOptions(), boardOverlay(100, 40));
		}
	});

	it("sends nothing when the board closes without comments, and counts several", async () => {
		const ui = new FakeUi().keys([KEYS.escape]);
		const sent: string[] = [];
		assert.deepEqual(await openBoard(ctx(ui), { data: () => architect(), send: (t) => sent.push(t) }), []);
		assert.equal(sent.length, 0);
		const two = new FakeUi().keys(["1", "c", "a", KEYS.enter, KEYS.down, "c", "b", KEYS.enter, "q", KEYS.enter]);
		await openBoard(ctx(two), { data: () => architect(), send: (t) => sent.push(t) });
		assert.equal(two.notifications.at(-1)!.message, "Sent 2 board comments to the agent.");
	});
});

describe("/architect board and ctrl+alt+b", () => {
	const entry = (input: EventInput): BranchEntry => ({ type: "custom", customType: ENTRY_TYPE, data: event(input) });
	const started = () => [
		entry({ type: "mode", mode: "architect", at: 1 }),
		entry({ type: "begin", feature: "Dedupe", slug: "dedupe", at: 1 }),
		entry({ type: "update", phase: "frame", brief: { goal: "One event per incident.", doneWhen: ["npm test"] } }),
	];

	it("opens the board as an overlay, completes, and sends the comments as a user message", async () => {
		const ui = new FakeUi().keys(["c", ...type("Say per incident"), KEYS.enter, KEYS.escape, KEYS.enter]);
		const h = harness({ ui, branch: started() });
		await h.fire("session_start", { reason: "resume" });
		assert.deepEqual(
			(h.commands.architect!.getArgumentCompletions!("bo") as { value: string }[]).map((i) => i.value),
			["board"],
		);
		await h.command("architect", "board");
		assert.equal((ui.customs[0]!.options as { overlay: boolean }).overlay, true);
		assert.match(ui.customs[0]!.frames[0]!.join("\n"), /◆ Board {2}Dedupe[\s\S]*GOAL[\s\S]*One event per incident\./);
		assert.deepEqual(h.userMessages, [
			{ content: "Board comments:\n- brief goal: Say per incident", options: undefined },
		]);
		assert.ok(ui.done);
	});

	it("steers the comments in when the agent is busy", async () => {
		const ui = new FakeUi().keys(["c", "x", KEYS.enter, "q", KEYS.enter]);
		const h = harness({ ui, branch: started() });
		await h.fire("session_start", { reason: "resume" });
		h.ctx.isIdle = () => false;
		await h.shortcuts[BOARD_SHORTCUT]!(h.ctx);
		assert.deepEqual(h.userMessages, [
			{ content: "Board comments:\n- brief goal: x", options: { deliverAs: "steer" } },
		]);
		assert.equal(ui.notifications.at(-1)!.message, "Queued 1 board comment for the agent's next step.");
	});

	it("opens one board when ctrl+alt+b comes twice before the first one shows", async () => {
		const ui = new FakeUi().keys([KEYS.escape]);
		const h = harness({ ui, branch: started() });
		await h.fire("session_start", { reason: "resume" });
		const first = h.shortcuts[BOARD_SHORTCUT]!(h.ctx);
		const second = h.shortcuts[BOARD_SHORTCUT]!(h.ctx);
		await Promise.all([first, second]);
		assert.equal(ui.customs.length, 1);
		ui.keys([KEYS.escape]);
		await h.shortcuts[BOARD_SHORTCUT]!(h.ctx);
		assert.equal(ui.customs.length, 2, "it opens again once closed");
	});

	it("redraws the open board when the agent changes the architecture", async () => {
		const ui = new FakeUi();
		const h = harness({ ui, branch: started() });
		await h.fire("session_start", { reason: "resume" });
		ui.keys([
			() => void h.call("architect_update", { risks: [{ text: "Clock skew", severity: "high" }] }),
			"5",
			KEYS.escape,
		]);
		await h.command("architect", "board");
		assert.match(ui.customs[0]!.frames.at(-1)!.join("\n"), /r1 {2}▰▰▰ high {3}Clock skew/);
	});

	it("shows the approved plan read-only in build mode, from the plan file", async () => {
		const ui = new FakeUi();
		const h = harness({ ui, branch: started() });
		const dir = join(h.cwd, "docs", "plans");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "dedupe.md"), "---\nfeature: x\n---\n\n# Dedupe from disk\n");
		h.branch.push(entry({ type: "plan", path: "docs/plans/dedupe.md", feature: "Dedupe", slug: "dedupe", at: 2 }));
		h.branch.push(entry({ type: "mode", mode: "build", at: 3 }));
		await h.fire("session_start", { reason: "resume" });
		ui.keys(["c", "x", KEYS.escape]);
		await h.shortcuts[BOARD_SHORTCUT]!(h.ctx);
		const frame = ui.customs[0]!.frames.at(-1)!.join("\n");
		assert.match(frame, /read-only/);
		assert.match(frame, /Dedupe from disk/);
		assert.deepEqual(h.userMessages, []);
		assert.match(ui.widgetLines(WIDGET_KEY)![0]!, /ctrl\+alt\+b board$/);
	});

	it("says what is missing instead of opening, without a UI or an architecture", async () => {
		const ui = new FakeUi();
		const h = harness({ ui });
		await h.fire("session_start", { reason: "startup" });
		await h.command("architect", "board");
		assert.equal(ui.customs.length, 0);
		assert.match(ui.notifications.at(-1)!.message, /no architecture to show yet/);
		const rpc = harness({ ui: new FakeUi(), mode: "rpc", branch: started() });
		await rpc.fire("session_start", { reason: "resume" });
		await rpc.command("architect", "board");
		assert.match(rpc.ui!.notifications.at(-1)!.message, /needs Pi's interactive terminal/);
	});

	it("shows the shortcut in the stepper while it fits", async () => {
		const ui = new FakeUi();
		const h = harness({ ui, branch: started() });
		await h.fire("session_start", { reason: "resume" });
		assert.match(ui.widgetLines(WIDGET_KEY, 140)![0]!, /● Frame .* {3}ctrl\+alt\+b board$/);
		assert.doesNotMatch(ui.widgetLines(WIDGET_KEY, 80)![0]!, /board/);
	});
});

describe("the board over a review screen or decision card", () => {
	const decide = (h: ReturnType<typeof harness>) =>
		h.call("architect_decide", {
			question: "Where do events get deduplicated?",
			options: [
				{ title: "In processor", pros: ["one owner"], cons: ["state"], effort: 2, risk: 1 },
				{ title: "In backend", pros: ["DB context"], cons: ["later"], effort: 3, risk: 2 },
			],
			recommended: "A",
			reason: "One owner.",
		});
	const deciding = () => [
		...framed(),
		entry({ type: "verdict", phase: "frame", verdict: "approved", at: 2 }),
		entry({ type: "verdict", phase: "explore", verdict: "approved", at: 3 }),
	];

	it("closes the board when a decision card opens, so the card is never hidden, and keeps its comments", async () => {
		const ui = new FakeUi();
		const h = harness({ ui, branch: deciding() });
		await h.fire("session_start", { reason: "resume" });
		let result: Awaited<ReturnType<typeof decide>> | undefined;
		ui.keys(
			// The board, with one comment saved and one still in the editor, when the agent asks.
			[
				"1",
				"c",
				...type("saved"),
				KEYS.enter,
				KEYS.down,
				"c",
				...type("typing"),
				async () => (result = await decide(h)),
			],
			[KEYS.enter],
		);
		await h.shortcuts[BOARD_SHORTCUT]!(h.ctx);
		const [board, card] = ui.customs;
		assert.equal((board!.options as { overlay?: boolean }).overlay, true);
		assert.equal((card!.options as { overlay?: boolean } | undefined)?.overlay, undefined, "the card is inline");
		assert.equal((result!.details as { chosen?: string }).chosen, "A");
		assert.deepEqual(h.userMessages, [], "nothing was sent");
		assert.equal(
			ui.notifications.at(-1)!.message,
			"The board closed so you can answer the agent. Your 2 comments are kept for when you open it again.",
		);
		// The next board starts with the draft, and sends it.
		ui.keys([KEYS.escape, KEYS.enter]);
		await h.shortcuts[BOARD_SHORTCUT]!(h.ctx);
		assert.match(ui.customs[2]!.frames[0]!.join("\n"), /✎ 2 to send/);
		const sent = h.userMessages as { content: unknown }[];
		assert.equal(sent.length, 1);
		assert.match(String(sent[0]!.content), /: saved\n- .*: typing$/);
	});

	it("closes the board for a review screen the same way", async () => {
		const ui = new FakeUi();
		const h = harness({ ui, branch: framed() });
		await h.fire("session_start", { reason: "resume" });
		ui.keys(["c", ...type("note"), KEYS.enter, () => h.call("architect_advance", {})], [KEYS.enter]);
		await h.command("architect", "board");
		assert.equal(ui.customs.length, 2);
		assert.equal(rebuild(h.branch).architecture!.phase, "explore");
		assert.deepEqual(h.userMessages, []);
		ui.keys([KEYS.escape, "d"]);
		await h.command("architect", "board");
		assert.match(ui.customs[2]!.frames[0]!.join("\n"), /✎ 1 to send/);
	});

	it("does not open a board that was still loading when a card opened", async () => {
		const ui = new FakeUi();
		const h = harness({ ui, branch: deciding() });
		await h.fire("session_start", { reason: "resume" });
		// ctrl+alt+b, then the agent's card opens before the board is loaded; the board finishes loading
		// while the card is open.
		ui.keys([() => board, KEYS.enter]);
		const board = Promise.resolve(h.shortcuts[BOARD_SHORTCUT]!(h.ctx));
		await decide(h);
		assert.equal(ui.customs.length, 1, "only the card opened");
	});

	const entry = (input: EventInput): BranchEntry => ({ type: "custom", customType: ENTRY_TYPE, data: event(input) });
	const framed = () => [
		entry({ type: "mode", mode: "architect", at: 1 }),
		entry({ type: "begin", feature: "Dedupe", slug: "dedupe", at: 1 }),
		entry({ type: "update", phase: "frame", brief: { goal: "One event per incident.", doneWhen: ["npm test"] } }),
	];

	it("opens read-only with b during the review's grace period, and the review goes on where it was", async () => {
		let t = 10_000;
		const ui = new FakeUi();
		const h = harness({ ui, branch: framed(), overrides: { now: () => t, inputGrace: 300 } });
		await h.fire("session_start", { reason: "resume" });
		ui.keys(
			["b", () => ui.screenClosed(), () => (t += 300), KEYS.enter],
			["c", ...type("ignored"), KEYS.enter, "x", "m", KEYS.escape],
		);
		const result = await h.call("architect_advance", {});
		const [review, overlay] = ui.customs;
		assert.match(review!.frames[0]!.join("\n"), /↵ approve Frame {2}r request changes {2}b board {2}esc close/);
		assert.equal((overlay!.options as { overlay: boolean }).overlay, true);
		const frame = overlay!.frames.at(-1)!.join("\n");
		assert.match(frame, /◆ Board {2}Dedupe[\s\S]*read-only/);
		assert.match(frame, /One event per incident\./);
		assert.doesNotMatch(frame, /comment|✎/);
		assert.equal(review!.frames.at(-1)!.join("\n"), review!.frames[0]!.join("\n"), "the review is as it was");
		assert.deepEqual(result.details, { phase: "frame", outcome: "approved", next: "explore" });
		assert.deepEqual(h.userMessages, []);
		assert.ok(ui.done);
	});

	it("opens read-only with b on a decision card, which keeps its focus", async () => {
		const ui = new FakeUi();
		const h = harness({
			ui,
			branch: [
				...framed(),
				entry({ type: "verdict", phase: "frame", verdict: "approved", at: 2 }),
				entry({ type: "verdict", phase: "explore", verdict: "approved", at: 3 }),
			],
		});
		await h.fire("session_start", { reason: "resume" });
		ui.keys([KEYS.right, "b", () => ui.screenClosed(), KEYS.enter], ["q"]);
		const result = await h.call("architect_decide", {
			question: "Where do events get deduplicated?",
			options: [
				{ title: "In processor", pros: ["one owner"], cons: ["state"], effort: 2, risk: 1 },
				{ title: "In backend", pros: ["DB context"], cons: ["later"], effort: 3, risk: 2 },
			],
			recommended: "A",
			reason: "One owner.",
		});
		const [card, overlay] = ui.customs;
		assert.match(card!.frames[0]!.join("\n"), /b board {2}esc close/);
		assert.match(overlay!.frames[0]!.join("\n"), /read-only/);
		assert.equal((result.details as { chosen?: string }).chosen, "B");
		assert.ok(ui.done);
	});
});

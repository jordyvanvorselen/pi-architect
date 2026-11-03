import { Markdown, stripTerminalSequences, type MarkdownTheme } from "@earendil-works/pi-tui";
import { renderDiagram } from "../../diagram/index.ts";
import { buildBlueprint } from "../../plan/blueprint.ts";
import { isDone, type SliceProgress } from "../../plan/progress.ts";
import { PHASE_LABEL, phaseIndex, type Phase } from "../../state/phases.ts";
import { phaseState, sliceProblems } from "../../state/queries.ts";
import type { Architecture, Decision, Diagram, Mode, PhaseState, PlanRef, Risk } from "../../state/types.ts";
import { optionCards } from "../decision/card.ts";
import type { Color, Paint } from "../paint.ts";
import { bullets, heading, paragraph, SEVERITY_COLOR } from "../review/common.ts";
import { decisionLines } from "../review/decide.ts";
import { legend, moduleMap } from "../review/explore.ts";
import { clipLine, lineWidth, raw, sp, wrap, wrapAfter, type Line, type Span } from "../spans.ts";

/** The board's tabs, in order. Keys 1–7 open them. */
export const TABS = ["brief", "explore", "decisions", "diagrams", "risks", "slices", "plan"] as const;
export type BoardTab = (typeof TABS)[number];

export const TAB_NAME: Record<BoardTab, string> = {
	brief: "Brief",
	explore: "Explore",
	decisions: "Decisions",
	diagrams: "Diagrams",
	risks: "Risks",
	slices: "Slices",
	plan: "Plan",
};

/** Three-letter names for narrow terminals. */
export const TAB_SHORT: Record<BoardTab, string> = {
	brief: "Brf",
	explore: "Exp",
	decisions: "Dec",
	diagrams: "Dgm",
	risks: "Rsk",
	slices: "Slc",
	plan: "Pln",
};

/** The phase that fills each tab. Risks can come in any phase, so their tab is open from the start. */
export const TAB_PHASE: Record<BoardTab, Phase> = {
	brief: "frame",
	explore: "explore",
	decisions: "decide",
	diagrams: "design",
	risks: "frame",
	slices: "slice",
	plan: "blueprint",
};

/** What the board shows. Read again whenever the architecture changes, so the board stays live. */
export interface BoardData {
	mode: Mode;
	arch?: Architecture;
	/** The plan file this session knows about. */
	plan?: PlanRef;
	/** The plan file's text as read when the board opened. Undefined when there is no file or it is missing. */
	planText?: string;
	/** Where approving the Blueprint writes the plan file. */
	planTarget?: string;
	/** Build progress from the plan file. */
	progress?: readonly SliceProgress[];
	/** Session id for the draft plan's front matter. */
	session?: string;
}

/** Theme hooks the content needs beyond plain colours. */
export interface BoardEnv {
	paint: Paint;
	markdown: MarkdownTheme;
}

/** One thing on the board the user can select and comment on: a decision, a diagram, a slice, a brief field… */
export interface BoardItem {
	/** Stable across updates, e.g. `q1`, `diagram:d2`, `brief:goal`. */
	key: string;
	/** How the agent reads it in a board comment: `q1`, `d2`, `slice 3 (s3)`, `brief goal`. */
	ref: string;
	/** What it is about, quoted in the comment when it adds something, e.g. the question. */
	label?: string;
	/** Lines above the item that belong to no item, like a group heading. */
	before?: (width: number) => Line[];
	lines: (width: number, expanded: boolean) => Line[];
	/** ↵ shows more of it. */
	expandable?: boolean;
	/** ↵ opens the diagram in the scrolling detail view. */
	diagram?: Diagram;
}

/** Shown on a tab without items: what will appear there and when. */
export interface EmptyState {
	title: string;
	/** `Comes in Decide · phase 3 of 6`, or why it is empty. */
	note?: string;
	text: string;
}

export interface TabContent {
	/** Lines above the items, like the severity counts on Risks. */
	head?: (width: number) => Line[];
	items: BoardItem[];
	empty?: EmptyState;
}

/** What the tab bar shows for a tab. */
export interface TabSummary {
	count?: number;
	/** `(1 open)` and the like. */
	extra?: Span;
	/** The phase that fills it has started, or it has content anyway. Dim otherwise. */
	reached: boolean;
	/** The tab of the phase the agent works on, or one in review. */
	current?: PhaseState;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Text cut to one line for a label. */
const short = (text: string, max = 60) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

function reached(arch: Architecture, tab: BoardTab): boolean {
	return arch.approvedAt !== undefined || phaseIndex(arch.phase) >= phaseIndex(TAB_PHASE[tab]);
}

/** Count and state of every tab, for the tab bar. */
export function summarize(data: BoardData, tab: BoardTab): TabSummary {
	const arch = data.arch;
	if (!arch) return { reached: tab === "plan" && data.planText !== undefined };
	const state = tab === "risks" ? undefined : phaseState(arch, TAB_PHASE[tab]);
	const current = state === "working" || state === "review" ? state : undefined;
	const base = { reached: reached(arch, tab), ...(current ? { current } : {}) };
	switch (tab) {
		case "brief":
			return base;
		case "explore":
			return { ...base, count: arch.modules.length + arch.findings.length };
		case "decisions": {
			const open = arch.decisions.filter((d) => d.chosen === undefined).length;
			return {
				...base,
				count: arch.decisions.length,
				...(open ? { extra: sp(`(${open} open)`, "warning") } : {}),
			};
		}
		case "diagrams":
			return { ...base, reached: base.reached || arch.diagrams.length > 0, count: arch.diagrams.length };
		case "risks": {
			const high = arch.risks.filter((r) => r.severity === "high").length;
			return { ...base, count: arch.risks.length, ...(high ? { extra: sp(`(${high} high)`, "error") } : {}) };
		}
		case "slices": {
			const progress = data.progress;
			const done = progress?.filter(isDone).length ?? 0;
			return {
				...base,
				count: arch.slices.length,
				...(progress?.length ? { extra: sp(`(${done}/${progress.length} done)`, "success") } : {}),
			};
		}
		case "plan":
			return {
				...base,
				extra: data.planText !== undefined ? sp("written", "success") : sp("draft", "dim"),
			};
	}
}

// ── Brief ────────────────────────────────────────────────────────────────────────────────────────

function briefContent(arch: Architecture): TabContent {
	const { brief } = arch;
	const counted = (n: number): Line => (n ? [sp(String(n), "dim")] : []);
	return {
		items: [
			{
				key: "brief:goal",
				ref: "brief goal",
				lines: (w) => [
					heading("Goal", w),
					...(brief.goal ? paragraph(brief.goal, w, "text", true) : [[sp("not set yet", "warning")]]),
				],
			},
			{
				key: "brief:constraints",
				ref: "brief constraints",
				lines: (w) => [heading("Constraints", w, counted(brief.constraints.length)), ...bullets(brief.constraints, w)],
			},
			{
				key: "brief:out-of-scope",
				ref: "brief out of scope",
				lines: (w) => [
					heading("Out of scope", w, counted(brief.outOfScope.length)),
					...bullets(brief.outOfScope, w, "×", "dim", "muted"),
				],
			},
			{
				key: "brief:done-when",
				ref: "brief done-when",
				lines: (w) => [
					heading("Done when", w, counted(brief.doneWhen.length)),
					...bullets(brief.doneWhen, w, "☐", "success"),
				],
			},
		],
	};
}

// ── Explore ──────────────────────────────────────────────────────────────────────────────────────

function exploreContent(arch: Architecture): TabContent {
	const items: BoardItem[] = [];
	if (arch.modules.length)
		items.push({
			key: "explore:modules",
			ref: "module map",
			lines: (w) => [heading("Modules", w, legend), ...moduleMap(arch.modules, w)],
		});
	arch.findings.forEach((f, i) =>
		items.push({
			key: `finding:${f.id}`,
			ref: f.id,
			label: short(f.text),
			...(i === 0
				? { before: (w: number) => [heading("Findings", w, [sp(String(arch.findings.length), "dim")])] }
				: {}),
			lines: (w) => wrapAfter([sp(`${f.id} `.padEnd(4), "dim")], f.text, w, "text"),
		}),
	);
	return {
		items,
		empty: {
			title: "Explore",
			text: "The module map appears here once the agent has read the code: what changes, what is new and what is only context, with the key findings.",
		},
	};
}

// ── Decisions ────────────────────────────────────────────────────────────────────────────────────

/** A decision opened up: the question, every option as a card with meters, the recommendation and the choice. */
export function expandedDecision(decision: Decision, width: number): Line[] {
	const tag = `${decision.id} `.padEnd(4);
	const indent = sp(" ".repeat(tag.length));
	const inner = Math.max(1, width - tag.length);
	const lines: Line[] = wrap(decision.question, inner).map((l, i) => [
		sp(i ? indent.text : tag, "dim"),
		sp(l, "text", true),
	]);
	if (decision.context) lines.push(...wrap(decision.context, inner).map((l) => [indent, sp(l, "muted")]));
	const focus = decision.options.findIndex((o) => o.id === decision.chosen);
	lines.push([], ...optionCards({ decision, focus, mode: "browse" }, inner).map((l) => [indent, ...l]));
	const recommended = decision.options.find((o) => o.id === decision.recommendation);
	if (recommended) {
		lines.push([]);
		lines.push(
			...wrapAfter(
				[indent, sp("★ ", "warning"), sp("Agent recommends ", "dim"), sp(recommended.id, "accent", true), sp("  ")],
				recommended.title,
				width,
				"text",
			),
		);
		if (decision.reason) lines.push(...wrapAfter([indent, sp("  ")], decision.reason, width, "muted"));
	}
	const chosen = decision.options.find((o) => o.id === decision.chosen);
	lines.push([]);
	if (chosen) {
		lines.push(
			...wrapAfter(
				[indent, sp("✓ ", "success"), sp("You chose ", "dim"), sp(chosen.id, "accent", true), sp("  ")],
				chosen.title,
				width,
				"text",
				true,
			),
		);
		if (decision.comment) lines.push(...wrapAfter([indent, sp("  ")], `"${decision.comment}"`, width, "muted"));
	} else lines.push([indent, sp("○ open", "warning"), sp(" · the agent asks you on a decision card", "dim")]);
	return lines;
}

function decisionsContent(arch: Architecture): TabContent {
	return {
		items: arch.decisions.map((d) => ({
			key: `decision:${d.id}`,
			ref: d.id,
			label: short(d.question),
			expandable: true,
			lines: (w, expanded) => (expanded ? expandedDecision(d, w) : decisionLines(d, w)),
		})),
		empty: reached(arch, "decisions")
			? { title: "Decisions", note: "none raised", text: "No open questions. The design follows from the brief." }
			: {
					title: "Decisions",
					text: "Each open question appears here with its options side by side, their effort and risk, and the agent's recommendation. You pick one for each.",
				},
	};
}

// ── Diagrams ─────────────────────────────────────────────────────────────────────────────────────

const PLAIN: Paint = { fg: (_color, text) => text, bold: (text) => text };

/** A diagram as a card that fits the width. A cut-off one points to the full view. */
export function diagramCard(diagram: Diagram, width: number, paint: Paint): Line[] {
	const d = {
		title: `${diagram.id}  ${diagram.title}`,
		body: diagram.body,
		...(diagram.caption ? { caption: diagram.caption } : {}),
	};
	const options = { fullView: "the full view with ↵" };
	const plain = renderDiagram(d, width, PLAIN, options);
	return renderDiagram(d, width, paint, options).map((line, i) => [raw(line, plain[i] ?? "")]);
}

function diagramsContent(arch: Architecture, paint: Paint): TabContent {
	const current = arch.diagrams.filter((d) => d.phase === "explore");
	const design = arch.diagrams.filter((d) => d.phase !== "explore");
	const group = (list: Diagram[], title: string): BoardItem[] =>
		list.map((d, i) => ({
			key: `diagram:${d.id}`,
			ref: d.id,
			label: d.title,
			diagram: d,
			...(i === 0 ? { before: (w: number) => [heading(title, w, [sp(plural(list.length, "diagram"), "dim")])] } : {}),
			lines: (w) => diagramCard(d, w, paint),
		}));
	return {
		items: [...group(current, "Current shape"), ...group(design, "Design")],
		empty: {
			title: "Diagrams",
			text: "The components, the data flow and the key flows appear here as diagrams, with new, changed and removed parts highlighted.",
		},
	};
}

// ── Risks ────────────────────────────────────────────────────────────────────────────────────────

const SEVERITY_BAR: Record<Risk["severity"], string> = { high: "▰▰▰", medium: "▰▰▱", low: "▰▱▱" };

function riskLines(risk: Risk, width: number): Line[] {
	const color = SEVERITY_COLOR[risk.severity];
	const prefix: Line = [
		sp(`${risk.id} `.padEnd(4), "dim"),
		sp(SEVERITY_BAR[risk.severity], color),
		sp(` ${risk.severity.padEnd(7)}`, color, risk.severity === "high"),
	];
	const lines = wrapAfter(prefix, risk.text, width, "text");
	if (risk.mitigation)
		lines.push(...wrapAfter([sp(" ".repeat(lineWidth(prefix))), sp("↳ ", "dim")], risk.mitigation, width, "muted"));
	return lines;
}

function risksContent(arch: Architecture): TabContent {
	const sorted = buildBlueprint(arch).risks;
	const count = (severity: Risk["severity"]) => arch.risks.filter((r) => r.severity === severity).length;
	return {
		...(sorted.length
			? {
					head: (w: number) => [
						clipLine(
							(["high", "medium", "low"] as const).flatMap((s, i) => [
								...(i ? [sp("   ")] : []),
								sp(`${SEVERITY_BAR[s]} `, SEVERITY_COLOR[s]),
								sp(`${count(s)} ${s}`, count(s) ? "text" : "dim"),
							]),
							w,
						),
						[],
					],
				}
			: {}),
		items: sorted.map((r) => ({
			key: `risk:${r.id}`,
			ref: r.id,
			label: short(r.text),
			lines: (w) => riskLines(r, w),
		})),
		empty: {
			title: "Risks",
			note: "none yet",
			text: "The agent records risks here as it finds them, in any phase, with how to soften each one.",
		},
	};
}

// ── Slices ───────────────────────────────────────────────────────────────────────────────────────

const SLICE_GLYPH = { done: ["✓", "success"], active: ["●", "accent"], pending: ["○", "dim"] } as const;

function slicesContent(arch: Architecture, progress: readonly SliceProgress[] | undefined): TabContent {
	const order = buildBlueprint(arch).slices;
	const numberOf = new Map(order.map((o) => [o.slice.id, o.number]));
	const sizes = new Map<number, number>();
	for (const o of order) sizes.set(o.step, (sizes.get(o.step) ?? 0) + 1);
	const firstActive = progress?.find((p) => !isDone(p))?.number;
	const problems = sliceProblems(arch.slices);
	const items: BoardItem[] = order.map((o, i) => {
		const { slice, number, step } = o;
		const p = progress?.find((x) => x.number === number);
		const state = p ? (isDone(p) ? "done" : number === firstActive ? "active" : "pending") : undefined;
		const newStep = i === 0 || order[i - 1]!.step !== step;
		const parallel = sizes.get(step)! > 1;
		const deps = slice.dependsOn.map((d) => String(numberOf.get(d) ?? d));
		const ref = `slice ${number}${slice.id !== String(number) ? ` (${slice.id})` : ""}`;
		return {
			key: `slice:${slice.id}`,
			ref,
			label: slice.title,
			expandable: true,
			...(newStep
				? {
						before: (w: number) => [
							heading(`Step ${step}`, w, parallel ? [sp(`${sizes.get(step)} in parallel`, "dim")] : []),
						],
					}
				: {}),
			lines: (w, expanded) => {
				const [glyph, color] = state ? SLICE_GLYPH[state] : (["●", "accent"] as const);
				const right: Line = [
					...(deps.length ? [sp("← ", "accent"), sp(deps.join(", "), "accent")] : []),
					...(p
						? [sp(deps.length ? "   " : ""), sp(`${p.checked}/${p.total}`, state === "done" ? "success" : "dim")]
						: []),
				];
				const left: Line = [
					sp(`${glyph} `, color),
					sp(String(number).padEnd(3), "accent", true),
					sp(slice.title, state === "done" ? "muted" : "text", true),
				];
				const space = w - lineWidth(left) - lineWidth(right);
				const pad: Line = [sp("     ")];
				const lines: Line[] =
					space >= 2
						? [[...left, sp(" ".repeat(space)), ...right]]
						: [
								...wrapAfter(left.slice(0, 2), slice.title, w, state === "done" ? "muted" : "text", true),
								...(right.length ? [clipLine([...pad, ...right], w)] : []),
							];
				if (slice.goal) lines.push(...wrapAfter(pad, slice.goal, w, "muted"));
				if (!expanded) {
					const facts = [
						plural(slice.files.length, "file"),
						plural(slice.steps.length, "step"),
						plural(slice.verify.length, "check"),
					].join(" · ");
					lines.push([...pad, sp(facts, "dim")]);
					return lines;
				}
				const field = (label: string, text: string, color: Color) =>
					wrapAfter([...pad, sp(label.padEnd(8), "dim")], text, w, color);
				if (slice.files.length) lines.push(...field("files", slice.files.join(", "), "muted"));
				slice.steps.forEach((s, n) => lines.push(...field(n ? "" : "steps", `${n + 1}. ${s}`, "text")));
				if (slice.verify.length)
					slice.verify.forEach((v, n) =>
						lines.push(
							...wrapAfter([...pad, sp((n ? "" : "verify").padEnd(8), "dim"), sp("$ ", "accent")], v, w, "text"),
						),
					);
				else lines.push([...pad, sp("verify".padEnd(8), "dim"), sp("missing", "warning")]);
				return lines;
			},
		};
	});
	return {
		...(problems.length
			? { head: (w: number) => [...problems.flatMap((x) => wrapAfter([sp("✗ ", "error")], x, w, "error")), []] }
			: {}),
		items,
		empty: {
			title: "Slices",
			text: "The work appears here split into buildable slices in build order, each with its files, concrete steps and the commands that prove it works.",
		},
	};
}

// ── Plan ─────────────────────────────────────────────────────────────────────────────────────────

/** The plan as markdown without its front matter, which the header line already says. */
export function planBody(text: string): string {
	return text.replace(/^---\n[\s\S]*?\n---\n+/, "");
}

function planContent(data: BoardData, draft: () => string, env: BoardEnv): TabContent {
	const file = data.planText;
	const text = file ?? (data.arch ? draft() : undefined);
	if (text === undefined)
		return {
			items: [],
			empty: data.plan
				? {
						title: "Plan",
						note: "file not found",
						text: `The plan file ${data.plan.path} is missing. /plan write writes it again.`,
					}
				: { title: "Plan", text: "The plan appears here as the agent fills in the phases." },
		};
	let markdown: { width: number; lines: Line[] } | undefined;
	const render = (w: number): Line[] => {
		if (markdown?.width !== w) {
			const md = new Markdown(planBody(text), 0, 0, env.markdown);
			markdown = { width: w, lines: md.render(w).map((l) => [raw(l, stripTerminalSequences(l))]) };
		}
		return markdown.lines;
	};
	const approved = data.arch?.approvedAt !== undefined;
	const header = (w: number): Line[] => {
		if (file !== undefined && data.plan)
			return wrapAfter(
				[sp("▣ ", "success"), sp(approved || !data.arch ? "Approved plan  " : "Plan file  ", "text", true)],
				data.plan.path,
				w,
				"accent",
			);
		const target = data.planTarget;
		return [
			[sp("▢ ", "warning"), sp("Draft", "warning", true), sp("  not written yet", "dim")],
			...(target ? wrapAfter([sp("  Approving the Blueprint writes ", "muted")], target, w, "accent") : []),
		];
	};
	return {
		items: [
			{
				key: "plan",
				ref: "plan",
				lines: (w) => [...header(w), [sp("─".repeat(Math.max(0, w)), "borderMuted")], ...render(w)],
			},
		],
	};
}

// ── All tabs ─────────────────────────────────────────────────────────────────────────────────────

/** Where a tab's phase stands, for its empty state: `Comes in Decide · phase 3 of 6 · now Explore`. */
function comesIn(arch: Architecture, tab: BoardTab): string {
	const phase = TAB_PHASE[tab];
	return `Comes in ${PHASE_LABEL[phase]} · phase ${phaseIndex(phase) + 1} of 6 · now ${PHASE_LABEL[arch.phase]}`;
}

/** Everything on one tab. `draft` renders the plan from the architecture, for the Plan tab. */
export function tabContent(tab: BoardTab, data: BoardData, env: BoardEnv, draft: () => string): TabContent {
	const arch = data.arch;
	if (tab === "plan") return planContent(data, draft, env);
	if (!arch)
		return {
			items: [],
			empty: {
				title: TAB_NAME[tab],
				note: "not in this session",
				text: data.plan
					? `This session builds from ${data.plan.path}. The whole design is in that file: open the Plan tab with 7.`
					: "There is no architecture in this session. /architect <feature> starts one.",
			},
		};
	const content =
		tab === "brief"
			? briefContent(arch)
			: tab === "explore"
				? exploreContent(arch)
				: tab === "decisions"
					? decisionsContent(arch)
					: tab === "diagrams"
						? diagramsContent(arch, env.paint)
						: tab === "risks"
							? risksContent(arch)
							: slicesContent(arch, data.progress);
	if (!content.items.length && content.empty && !content.empty.note && !reached(arch, tab))
		content.empty = { ...content.empty, note: comesIn(arch, tab) };
	return content;
}

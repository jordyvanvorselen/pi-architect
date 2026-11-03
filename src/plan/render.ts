import { slugify } from "../state/queries.ts";
import type { Architecture, Diagram, ModuleRole, Severity } from "../state/types.ts";
import { buildBlueprint, type Blueprint, type BlueprintDecision, type BlueprintOption } from "./blueprint.ts";
import type { Ordered } from "./order.ts";

export interface RenderOptions {
	/** Id of the session that produced the plan, for the front matter. */
	session?: string;
}

/** Heading of the slices section. The progress parser looks for it. */
export const SLICES_HEADING = "## Slices";
/** Text of the last checkbox of every slice. */
export const VERIFIED = "Verified: every command above passes.";

/** Apply `fn` to the parts of `text` outside code spans, so code stays as written. */
function outsideCode(text: string, fn: (part: string) => string): string {
	let result = "";
	let i = 0;
	while (i < text.length) {
		const open = text.indexOf("`", i);
		if (open === -1) break;
		const run = /^`+/.exec(text.slice(open))![0];
		const close = new RegExp(`(?<!\`)${run}(?!\`)`).exec(text.slice(open + run.length));
		if (!close) break;
		const end = open + run.length + close.index + run.length;
		result += fn(text.slice(i, open)) + text.slice(open, end);
		i = end;
	}
	return result + fn(text.slice(i));
}

/**
 * Emphasis the way prettier writes it: `_a_` rather than `*a*`, `**a**` rather than `__a__`. Same meaning,
 * and the file stays stable when the user runs prettier on it.
 */
function emphasis(text: string): string {
	return text
		.replace(/(?<![_\w\\])__(?![_\s])([^_]+?)(?<![_\s])__(?![_\w])/g, "**$1**")
		.replace(/(?<![*\w\\])\*(?![*\s])([^*_]+?)(?<![*\s\\])\*(?![*\w])/g, "_$1_");
}

/** One line: no line breaks, single spaces. */
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** One line of prose, with emphasis as prettier writes it. */
function inline(text: string): string {
	return outsideCode(flat(text), emphasis);
}

/**
 * Prose that starts a list item or a paragraph. Escapes a start that markdown would read as a heading,
 * quote, list, task box or thematic break, so the plan keeps its structure whatever the agent wrote.
 */
function prose(text: string): string {
	const line = inline(text);
	if (/^(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|\d{1,9}[.)](?:\s|$)|\[[ xX]\]\s|={3,}$|([-*_])(?:\s*\1){2,}\s*$)/.test(line))
		return `\\${line}`;
	return line;
}

/** A path or name as inline code, with a fence that its own backticks cannot close. */
function code(text: string): string {
	const value = flat(text);
	const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
	return `${fence}${pad}${value}${pad}${fence}`;
}

/** A fenced block with a fence longer than any backtick run in the body. Trailing blank lines are dropped. */
function fenced(body: string, lang: string): string {
	const lines = body.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
	while (lines.length && !lines[0]!.trim()) lines.shift();
	const text = lines.map((l) => l.replace(/\s+$/, "")).join("\n");
	const longest = Math.max(0, ...(text.match(/`{3,}/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${lang}\n${text}\n${fence}`;
}

const list = (items: readonly string[], empty = "None.") =>
	items.length ? items.map((item) => `- ${prose(item)}`).join("\n") : empty;

const yaml = (value: string) => JSON.stringify(value);

const ROLE: Record<ModuleRole, string> = { touched: "changes", new: "new", context: "read only" };
const SEVERITY: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low" };

function frontMatter(bp: Blueprint, options: RenderOptions): string {
	return [
		"---",
		`feature: ${yaml(bp.feature || bp.slug || "feature")}`,
		`slug: ${yaml(bp.slug || slugify(bp.feature))}`,
		`status: ${bp.status}`,
		...(bp.approvedAt !== undefined ? [`approvedAt: ${yaml(new Date(bp.approvedAt).toISOString())}`] : []),
		`slices: ${bp.counts.slices}`,
		...(options.session ? [`session: ${yaml(options.session)}`] : []),
		"generator: pi-architect",
		"---",
	].join("\n");
}

const HOW_TO = [
	"## How to build this plan",
	"This plan was designed with the user and approved. It holds everything you need to build the feature.",
	[
		"1. Read the whole plan before you change any code.",
		"2. Build the slices in order. Start a slice only when every slice it depends on is done.",
		"3. Follow the steps of the slice. Tick each step in this file, from `- [ ]` to `- [x]`, as soon as it is done.",
		'4. Run every verify command of the slice. Fix the code until they all pass. Then tick "Verified" and move on.',
		"5. The decisions are final. Do not reopen them or build a rejected option. If one cannot work, stop and ask the user.",
		"6. Stay inside the brief. Leave everything out of scope alone. Follow the existing patterns under Context.",
	].join("\n"),
];

function diagram(d: Diagram, level: string): string[] {
	return [`${level} ${inline(d.title)}`, fenced(d.body, "text"), ...(d.caption ? [prose(d.caption)] : [])];
}

function brief(bp: Blueprint): string[] {
	const b = bp.brief;
	return [
		"## Brief",
		"### Goal",
		b.goal ? prose(b.goal) : "Not set.",
		"### Constraints",
		list(b.constraints),
		"### Out of scope",
		list(b.outOfScope),
		"### Done when",
		list(b.doneWhen),
	];
}

function context(bp: Blueprint): string[] {
	const modules = bp.modules.map((m) => {
		const head = `- ${code(m.path)} (${ROLE[m.role]})${m.note ? `: ${inline(m.note)}` : ""}`;
		return [head, ...m.files.map((f) => `  - ${code(f)}`)].join("\n");
	});
	return [
		"## Context",
		"### Modules",
		modules.length ? modules.join("\n") : "None.",
		"### Findings and existing patterns",
		list(bp.findings.map((f) => f.text)),
		...(bp.currentShape.length ? ["### Current shape", ...bp.currentShape.flatMap((d) => diagram(d, "####"))] : []),
	];
}

const optionName = (o: BlueprintOption) => `${inline(o.id)}. ${inline(o.title)}`;

function option(o: BlueprintOption): string[] {
	return [
		...(o.summary ? [prose(o.summary)] : []),
		[...o.pros.map((p) => `- Pro: ${inline(p)}`), ...o.cons.map((c) => `- Con: ${inline(c)}`)].join("\n"),
		o.rating
			? `Effort ${o.rating.effort}/5, risk ${o.rating.risk}/5.`
			: "The user wrote this option. Nobody rated its effort or risk.",
	].filter(Boolean);
}

function decision(d: BlueprintDecision, index: number): string[] {
	const head = [`### ${index + 1}. ${inline(d.question)}`, ...(d.context ? [prose(d.context)] : [])];
	if (!d.chosen) return [...head, "**Open.** This question was not decided. Ask the user before you build it."];
	const rejected = d.rejected.map(({ option: o, recommended }) => {
		const why = o.cons.length ? `Not chosen: ${o.cons.map(inline).join("; ")}.` : "Not chosen.";
		const summary = o.summary ? ` ${inline(o.summary)}` : "";
		return `- **${optionName(o)}**${recommended ? " (recommended)" : ""}:${summary} ${why}`;
	});
	return [
		...head,
		`**Chosen: ${optionName(d.chosen)}**${d.followedRecommendation ? " (recommended)" : ""}`,
		...option(d.chosen),
		...(d.comment ? ["The user said:", `> ${inline(d.comment)}`] : []),
		...(rejected.length ? ["Rejected:", rejected.join("\n")] : []),
	];
}

function decisions(bp: Blueprint): string[] {
	return [
		"## Decisions",
		bp.decisions.length
			? "These are settled. Build the chosen option. Do not reopen them."
			: "No open questions came up.",
		...bp.decisions.flatMap(decision),
	];
}

function design(bp: Blueprint): string[] {
	return ["## Design", ...(bp.design.length ? bp.design.flatMap((d) => diagram(d, "###")) : ["No diagrams."])];
}

function risks(bp: Blueprint): string[] {
	const items = bp.risks.map(
		(r) =>
			`- **${SEVERITY[r.severity]}:** ${inline(r.text)}${r.mitigation ? ` Mitigation: ${inline(r.mitigation)}` : ""}`,
	);
	return ["## Risks", items.length ? items.join("\n") : "None known."];
}

function slice(o: Ordered, byId: Map<string, Ordered>): string[] {
	const s = o.slice;
	const deps = s.dependsOn
		.map((id) => byId.get(id))
		.filter((d): d is Ordered => d !== undefined)
		.sort((a, b) => a.number - b.number)
		.map((d) => `${d.number}. ${inline(d.slice.title)}`);
	return [
		`### ${o.number}. ${inline(s.title)}`,
		...(s.goal ? [`**Goal:** ${inline(s.goal)}`] : []),
		`**Depends on:** ${deps.length ? deps.join(", ") : "nothing"}`,
		"**Files:**",
		s.files.length ? s.files.map((f) => `- ${code(f)}`).join("\n") : "None listed.",
		"**Steps:**",
		s.steps.map((step) => `- [ ] ${inline(step)}`).join("\n") || "None listed.",
		"**Verify:**",
		...(s.verify.length
			? [fenced(s.verify.join("\n"), "bash")]
			: ["No commands given. Ask the user how to verify it."]),
		`- [ ] ${VERIFIED}`,
	];
}

function slices(bp: Blueprint): string[] {
	const byId = new Map(bp.slices.map((o) => [o.slice.id, o]));
	if (!bp.slices.length) return [SLICES_HEADING, "No slices."];
	const groups: number[][] = [];
	for (const o of bp.slices) (groups[o.step - 1] ??= []).push(o.number);
	const line = groups
		.map((g) => (g.length > 1 ? `${g.slice(0, -1).join(", ")} and ${g.at(-1)} in any order` : String(g[0])))
		.join(", then ");
	return [SLICES_HEADING, `Build order: ${line}.`, ...bp.slices.flatMap((o) => slice(o, byId))];
}

/**
 * The plan file as markdown: YAML front matter, then how to build it, the brief, the context, the
 * decisions, the design, the risks and the slices in build order. Pure and deterministic, so the same
 * architecture always gives the same file. Blocks are separated by one blank line, which keeps it
 * stable under prettier.
 */
export function renderPlan(arch: Architecture, options: RenderOptions = {}): string {
	const bp = buildBlueprint(arch);
	const blocks = [
		frontMatter(bp, options),
		`# ${inline(bp.feature || bp.slug || "Feature")}`,
		...HOW_TO,
		...brief(bp),
		...context(bp),
		...decisions(bp),
		...design(bp),
		...risks(bp),
		...slices(bp),
	];
	return `${blocks.join("\n\n")}\n`;
}

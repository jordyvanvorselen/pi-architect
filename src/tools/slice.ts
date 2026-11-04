import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { buildOrder, type Ordered } from "../plan/order.ts";
import type { SlicesEvent } from "../state/events.ts";
import { PHASE_LABEL, type Phase } from "../state/phases.ts";
import { missing, sliceProblems } from "../state/queries.ts";
import type { Architecture, Slice } from "../state/types.ts";
import type { Paint } from "../ui/paint.ts";
import { sliceCall, sliceResult } from "../ui/slice.ts";
import {
	architecture,
	clean,
	EXAMPLE_AFTER,
	List,
	parseJson,
	readiness,
	Rejections,
	textOf,
	textRow,
	type ToolDeps,
} from "./common.ts";

export const SliceParams = Type.Object(
	{
		slices: Type.Array(
			Type.Object(
				{
					id: Type.String({ description: 'Short id, e.g. "s1". Other slices refer to it in depends_on.' }),
					title: Type.String({ description: 'A few words, e.g. "Store the dedup key".' }),
					goal: Type.String({ description: "One sentence: what is true once this slice is built." }),
					depends_on: Type.Optional(List("Ids of slices that must be built first. Empty for none.")),
					files: List("Files the slice creates or changes, as paths."),
					steps: List("Concrete changes in order, one sentence each, naming the file, function or type."),
					verify: List("Exact shell commands that pass once the slice is done, e.g. npm test -- tests/dedup.test.ts."),
				},
				{ additionalProperties: false },
			),
			{ description: "Every slice of the plan. Replaces the earlier list, so always send all of them." },
		),
	},
	{ additionalProperties: false },
);

export type SliceInput = Static<typeof SliceParams>;

const ALIASES: Record<string, string> = { dependsOn: "depends_on", depends: "depends_on", after: "depends_on" };
const LISTS = new Set(["depends_on", "files", "steps", "verify"]);

function normalizeSlice(raw: unknown): unknown {
	const value = parseJson(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item === null) continue;
		const name = ALIASES[key] ?? key;
		const parsed = parseJson(item);
		result[name] = LISTS.has(name) && typeof parsed === "string" ? [parsed] : parsed;
	}
	return result;
}

/** Models send camelCase keys, JSON strings, one slice instead of a list or a bare list. Fold those in. */
export function prepareSliceArgs(raw: unknown): SliceInput {
	let args = parseJson(raw);
	if (Array.isArray(args)) args = { slices: args };
	if (!args || typeof args !== "object") return { slices: [] };
	let slices = parseJson((args as { slices?: unknown }).slices);
	if (slices && typeof slices === "object" && !Array.isArray(slices)) slices = [slices];
	return { slices: Array.isArray(slices) ? slices.map(normalizeSlice) : [] } as SliceInput;
}

/** Phases in which slices can change: Slice, and the Blueprint to fix a gap. */
const SLICE_PHASES: readonly Phase[] = ["slice", "blueprint"];

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/**
 * A whole step that says nothing a builder can act on. Only the entire step counts: "Delete the todo from
 * the Map" is a real step that happens to contain the word.
 */
const PLACEHOLDER_STEP =
	/^(?:tbd|todo|fixme|wip|n\/a|implement(?: it| this| the feature)?|do it|fix(?: it)?|misc|etc|\.\.\.|…|\?+|same as above)[.!]*$/i;
/** A step that opens with a marker saying it is unfinished, like "TODO: wire the cache". */
const PLACEHOLDER_PREFIX = /^(todo|tbd|fixme)\s*:/i;
/** Something a builder can find: a path, a call, a file extension, an identifier or code in backticks. */
const CONCRETE = /[/`(_]|\.[a-z]{1,5}\b|[a-z][A-Z]/;
/** A verify entry that describes a check instead of being one. The whole entry must match. */
const VAGUE_VERIFY =
	/^(?:tests?(?: pass(?:es)?)?|it works|works|manual(?:ly)?(?: (?:check|test(?:ing)?|qa))?|check|verify|review|tbd|todo|n\/a|run (?:the )?tests?)\.?$/i;

/** One problem with the slices, with its kind so a repeat can get an example. */
export interface SliceIssue {
	kind: "slices" | "id" | "title" | "goal" | "files" | "steps" | "placeholder" | "short" | "verify" | "graph";
	text: string;
}

/** Problems with one step, or undefined when a builder can act on it. Says exactly what matched. */
function stepProblem(step: string): (Omit<SliceIssue, "text"> & { why: string }) | undefined {
	if (PLACEHOLDER_STEP.test(step)) return { kind: "placeholder", why: "is only a placeholder" };
	const prefix = PLACEHOLDER_PREFIX.exec(step);
	if (prefix) return { kind: "placeholder", why: `starts with "${prefix[0]}", which marks it as unfinished` };
	const words = step.split(/\s+/).length;
	if (words < 2 || (words < 3 && !CONCRETE.test(step)))
		return {
			kind: "short",
			why: `has ${words === 1 ? "one word" : "two words"} and names no file, function or type`,
		};
	return undefined;
}

/** Everything wrong with the slices, one issue each, so the model can fix them all in one go. */
export function sliceIssues(slices: readonly Slice[]): SliceIssue[] {
	const issues: SliceIssue[] = [];
	const add = (kind: SliceIssue["kind"], text: string) => issues.push({ kind, text });
	if (!slices.length) add("slices", "Send at least one slice.");
	const seen = new Set<string>();
	slices.forEach((s, i) => {
		const name = s.id || `slice ${i + 1}`;
		if (!s.id) add("id", `slice ${i + 1}: needs an id.`);
		else if (!ID.test(s.id))
			add("id", `${name}: the id must be up to 32 letters, digits, dots, dashes or underscores, e.g. "s1".`);
		else if (seen.has(s.id)) add("id", `${name}: the id is used twice. Ids must be unique.`);
		seen.add(s.id);
		if (!s.title) add("title", `${name}: needs a title.`);
		else if (s.title.length > 80)
			add("title", `${name}: the title has ${s.title.length} characters, more than 80. Put the detail in the goal.`);
		if (!s.goal) add("goal", `${name}: needs a goal, one sentence on what is true once it is built.`);
		if (!s.files.length) add("files", `${name}: needs at least one file it creates or changes.`);
		if (!s.steps.length) add("steps", `${name}: needs at least one step.`);
		s.steps.forEach((step, j) => {
			const problem = stepProblem(step);
			if (problem)
				add(
					problem.kind,
					`${name}: step ${j + 1} ${problem.why}: ${JSON.stringify(step)}. Write the change itself, naming the file, function or type.`,
				);
		});
		if (!s.verify.length) add("verify", `${name}: needs at least one verify command.`);
		for (const command of s.verify)
			if (VAGUE_VERIFY.test(command))
				add(
					"verify",
					`${name}: verify ${JSON.stringify(command)} describes a check instead of being one. Give the exact shell command, e.g. "npm test".`,
				);
	});
	for (const problem of sliceProblems(slices)) add("graph", `${problem}.`);
	return issues;
}

/** Every problem with the slices, one line each. */
export function sliceErrors(slices: readonly Slice[]): string[] {
	return sliceIssues(slices).map((i) => i.text);
}

/** What a value that passes looks like, for a kind the model got wrong twice in a row. */
function example(kind: SliceIssue["kind"], slices: readonly Slice[]): string | undefined {
	const file = slices.find((s) => s.files.length)?.files[0] ?? "src/store.ts";
	const id = slices.find((s) => s.id && ID.test(s.id))?.id ?? "s1";
	switch (kind) {
		case "placeholder":
		case "short":
		case "steps":
			return `A step that passes is one sentence a builder can follow, e.g. "In ${file}, add removeItem(id) that deletes the item from the Map and returns true when it existed."`;
		case "verify":
			return `A verify entry that passes is a shell command that exits 0 once the slice is done, e.g. "npm test -- tests/${id}.test.ts" or "npx tsc --noEmit".`;
		case "id":
			return 'Ids that pass: "s1", "s2", "store-key". Every slice needs its own.';
		case "goal":
			return 'A goal that passes: "Deleting an item removes it from the store and the list."';
		case "files":
			return `Files that pass: ["${file}", "tests/${id}.test.ts"].`;
		case "title":
			return 'A title that passes: "Store the dedup key".';
		case "graph":
			return `depends_on lists ids of other slices in this call, without cycles, e.g. "depends_on": ["${id}"], or [] for none.`;
		case "slices":
			return undefined;
	}
}

export interface SliceDetails {
	phase: Phase;
	/** Ids per group in build order. */
	groups: string[][];
	titles: Record<string, string>;
	/** Slices added, changed and removed compared with the earlier list. */
	added: string[];
	changed: string[];
	removed: string[];
	missing: string[];
}

export interface SlicePlan {
	event: Omit<SlicesEvent, "v">;
	text: string;
	details: SliceDetails;
	order: Ordered[];
}

const same = (a: Slice, b: Slice) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Turn tool input into one `slices` event that replaces the list, and a short result with the build order.
 * Pure. Throws with every problem when the slices are not buildable as given.
 */
export function planSlices(arch: Architecture, input: SliceInput, rejections?: Rejections): SlicePlan {
	if (arch.approvedAt !== undefined) throw new Error("The plan is approved and final. Nothing can change now.");
	const phase = arch.phase;
	if (!SLICE_PHASES.includes(phase))
		throw new Error(`Slices belong to the Slice phase. You are in ${PHASE_LABEL[phase]}: finish it first.`);
	const slices: Slice[] = (input.slices ?? []).map((s) => {
		const goal = s.goal?.trim() ?? "";
		return {
			id: s.id?.trim() ?? "",
			title: s.title?.trim().replace(/\s+/g, " ") ?? "",
			...(goal ? { goal } : {}),
			dependsOn: [...new Set(clean(s.depends_on))],
			files: [...new Set(clean(s.files))],
			steps: clean(s.steps),
			verify: clean(s.verify),
		};
	});
	const issues = sliceIssues(slices);
	if (issues.length) {
		const kinds = [...new Set(issues.map((i) => i.kind))];
		rejections?.record(kinds);
		const examples = kinds
			.filter((k) => (rejections?.count(k) ?? 0) >= EXAMPLE_AFTER)
			.map((k) => example(k, slices))
			.filter((e) => e !== undefined);
		throw new Error(
			[
				`The slices were not saved. Fix ${issues.length === 1 ? "this" : "these"} and send the full list again:`,
				...issues.map((e) => `- ${e.text}`),
				...(examples.length ? ["The same problem came back. What passes:", ...examples.map((e) => `- ${e}`)] : []),
			].join("\n"),
		);
	}
	rejections?.clear();

	const old = new Map(arch.slices.map((s) => [s.id, s]));
	const added = slices.filter((s) => !old.has(s.id)).map((s) => s.id);
	const changed = slices.filter((s) => old.has(s.id) && !same(old.get(s.id)!, s)).map((s) => s.id);
	const removed = arch.slices.filter((s) => !slices.some((n) => n.id === s.id)).map((s) => s.id);

	const order = buildOrder(slices);
	const groups: string[][] = [];
	for (const o of order) (groups[o.step - 1] ??= []).push(o.slice.id);
	const gaps = missing({ ...arch, slices });
	const steps = groups.map((g, i) => `${i + 1}. ${g.join(" + ")}`).join(" → ");
	const next = readiness(phase, gaps);
	const parallel = groups.some((g) => g.length > 1) ? " Slices joined by + can be built in parallel." : "";
	return {
		event: { type: "slices", slices, replace: true },
		text: `Saved ${slices.length} slice${slices.length === 1 ? "" : "s"}. Build order: ${steps}.${parallel} ${next}`,
		details: {
			phase,
			groups,
			titles: Object.fromEntries(slices.map((s) => [s.id, s.title])),
			added,
			changed,
			removed,
			missing: gaps,
		},
		order,
	};
}

/** Register `architect_slice`. Inactive by default, like every architect tool; architect mode turns it on. */
export function registerSliceTool(pi: ExtensionAPI, deps: ToolDeps): void {
	const rejections = new Rejections();
	pi.registerTool({
		name: "architect_slice",
		label: "Architect slice",
		description:
			"Define every slice of the plan and return at once with the build order. Each slice has an id, title, goal, " +
			"depends_on (ids), files, concrete steps and exact verify commands. Replaces the earlier list, so send all " +
			"slices each time. Fails with every problem when slices are vague, unverifiable or depend in a cycle.",
		promptSnippet: "Define the buildable slices of the architect plan with their dependencies and verify commands",
		promptGuidelines: [
			"Use architect_slice in the Slice phase. A builder with no other context follows each step, so name the file, function or type in every step.",
		],
		parameters: SliceParams,
		defaultActive: false,
		prepareArguments: prepareSliceArgs,
		async execute(_toolCallId, params) {
			const plan = planSlices(architecture(deps.state(), "architect_slice"), params, rejections);
			deps.append(plan.event);
			return { content: [{ type: "text", text: plan.text }], details: plan.details };
		},
		renderCall: (args, theme, context) => textRow(context, sliceCall(args, theme as Paint)),
		renderResult: (result, { expanded }, theme, context) =>
			textRow(
				context,
				sliceResult(
					result.details as SliceDetails | undefined,
					textOf(result.content),
					expanded,
					context.isError,
					theme as Paint,
				),
			),
	});
}

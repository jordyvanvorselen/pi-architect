import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { buildOrder, type Ordered } from "../plan/order.ts";
import type { SlicesEvent } from "../state/events.ts";
import { PHASE_LABEL, type Phase } from "../state/phases.ts";
import { missing, sliceProblems } from "../state/queries.ts";
import type { Architecture, Slice } from "../state/types.ts";
import type { Paint } from "../ui/paint.ts";
import { sliceCall, sliceResult } from "../ui/slice.ts";
import { architecture, clean, List, parseJson, readiness, textOf, textRow, type ToolDeps } from "./common.ts";

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
/** Placeholders that say nothing a builder can act on. */
const VAGUE_STEP =
	/^(?:tbd|todo|wip|n\/a|implement(?: it| this| the feature)?|do it|fix(?: it)?|misc|etc\.?|\.\.\.|…|same as above)$/i;
const PLACEHOLDER = /\b(?:tbd|todo|fixme)\b|\?\?\?|\.\.\.$|…$|\betc\.?$/i;
const VAGUE_VERIFY =
	/^(?:tests?(?: pass(?:es)?)?|it works|works|manual(?:ly)?(?: (?:check|test(?:ing)?|qa))?|check|verify|review|tbd|todo|n\/a|run (?:the )?tests?)\.?$/i;

const quote = (text: string) => JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text);

/** Problems with one step, or undefined when a builder can act on it. */
function stepProblem(step: string): string | undefined {
	if (VAGUE_STEP.test(step) || PLACEHOLDER.test(step)) return "is a placeholder";
	if (step.split(/\s+/).length < 3 || step.length < 12) return "is too short to act on";
	return undefined;
}

/** Everything wrong with the slices, one line each, so the model can fix them all in one go. */
export function sliceErrors(slices: readonly Slice[]): string[] {
	const errors: string[] = [];
	if (!slices.length) errors.push("Send at least one slice.");
	const seen = new Set<string>();
	slices.forEach((s, i) => {
		const name = s.id || `slice ${i + 1}`;
		if (!s.id) errors.push(`slice ${i + 1}: needs an id.`);
		else if (!ID.test(s.id)) errors.push(`${name}: the id must be short, without spaces, e.g. "s1".`);
		else if (seen.has(s.id)) errors.push(`${name}: the id is used twice. Ids must be unique.`);
		seen.add(s.id);
		if (!s.title) errors.push(`${name}: needs a title.`);
		else if (s.title.length > 80) errors.push(`${name}: the title is longer than 80 characters.`);
		if (!s.goal) errors.push(`${name}: needs a goal, one sentence on what is true once it is built.`);
		if (!s.files.length) errors.push(`${name}: needs at least one file it creates or changes.`);
		if (!s.steps.length) errors.push(`${name}: needs at least one step.`);
		s.steps.forEach((step, j) => {
			const problem = stepProblem(step);
			if (problem)
				errors.push(
					`${name}: step ${j + 1} ${quote(step)} ${problem}. Name the file, function or type and the change.`,
				);
		});
		if (!s.verify.length) errors.push(`${name}: needs at least one verify command.`);
		for (const command of s.verify)
			if (VAGUE_VERIFY.test(command))
				errors.push(`${name}: verify ${quote(command)} is not a command. Give the exact command, e.g. "npm test".`);
	});
	errors.push(...sliceProblems(slices).map((p) => `${p}.`));
	return errors;
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
export function planSlices(
	arch: Architecture,
	input: SliceInput,
	has: (tool: string) => boolean = () => true,
): SlicePlan {
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
	const errors = sliceErrors(slices);
	if (errors.length)
		throw new Error(
			[
				`The slices were not saved. Fix ${errors.length === 1 ? "this" : "these"} and send the full list again:`,
				...errors.map((e) => `- ${e}`),
			].join("\n"),
		);

	const old = new Map(arch.slices.map((s) => [s.id, s]));
	const added = slices.filter((s) => !old.has(s.id)).map((s) => s.id);
	const changed = slices.filter((s) => old.has(s.id) && !same(old.get(s.id)!, s)).map((s) => s.id);
	const removed = arch.slices.filter((s) => !slices.some((n) => n.id === s.id)).map((s) => s.id);

	const order = buildOrder(slices);
	const groups: string[][] = [];
	for (const o of order) (groups[o.step - 1] ??= []).push(o.slice.id);
	const gaps = missing({ ...arch, slices }, has);
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
export function registerSliceTool(pi: ExtensionAPI, deps: ToolDeps & { has?: (tool: string) => boolean }): void {
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
			const plan = planSlices(architecture(deps.state(), "architect_slice"), params, deps.has);
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

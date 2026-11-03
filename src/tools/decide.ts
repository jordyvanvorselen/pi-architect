import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type { DecisionAnswer, DecisionUi } from "../decision.ts";
import { choiceSnapshot, type EventInput } from "../state/events.ts";
import { PHASE_LABEL } from "../state/phases.ts";
import { nextId } from "../state/queries.ts";
import type { ArchitectState, Decision, DecisionOption, Level } from "../state/types.ts";
import { decideCall, decideResult } from "../ui/decision/rows.ts";
import type { Paint } from "../ui/paint.ts";

const List = (description: string) => Type.Array(Type.String(), { description });
const Rating = (description: string) => Type.Integer({ minimum: 1, maximum: 5, description });

export const DecideParams = Type.Object(
	{
		question: Type.String({ description: "The open question, in one short sentence." }),
		context: Type.Optional(Type.String({ description: "Why it matters, in one or two short sentences." })),
		options: Type.Array(
			Type.Object(
				{
					title: Type.String({ description: 'A few words, e.g. "Dedupe in the processor".' }),
					summary: Type.Optional(Type.String({ description: "One sentence: what this option means." })),
					pros: Type.Optional(List("Short points in its favour.")),
					cons: Type.Optional(List("Short points against it.")),
					effort: Rating("1 trivial to 5 very large."),
					risk: Rating("1 safe to 5 likely to go wrong."),
				},
				{ additionalProperties: false },
			),
			{ minItems: 2, maxItems: 4, description: "2 to 4 real alternatives. The user sees them as A, B, C and D." },
		),
		recommended: Type.String({ description: 'Letter of the option you recommend, e.g. "B".' }),
		reason: Type.String({ description: "Why you recommend it, in one line." }),
		id: Type.Optional(
			Type.String({
				description: 'Ask decision "q2" again, e.g. after the user asked a question. Omit for a new one.',
			}),
		),
		total: Type.Optional(
			Type.Integer({ minimum: 1, description: "How many decisions you expect in this phase, if you know." }),
		),
	},
	{ additionalProperties: false },
);

export type DecideInput = Static<typeof DecideParams>;

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

function parseJson(value: unknown): unknown {
	if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

const toList = (value: unknown) => {
	const parsed = parseJson(value);
	return typeof parsed === "string" ? [parsed] : parsed;
};

/** "3", 3.4 and 9 become 3, 3 and 5. Anything else is left for validation to reject. */
function toLevel(value: unknown): unknown {
	const n = typeof value === "string" && value.trim() ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : value;
}

/**
 * Models send options as a JSON string, one string instead of a list, or ratings as text.
 * Fold those into the schema shape. Validation still runs afterwards.
 */
export function prepareDecideArgs(raw: unknown): DecideInput {
	const args = parseJson(raw);
	if (!args || typeof args !== "object" || Array.isArray(args)) return {} as DecideInput;
	const record: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) if (value !== null) record[key] = value;
	const options = parseJson(record.options);
	if (Array.isArray(options))
		record.options = options.map((option: unknown) => {
			if (!option || typeof option !== "object") return option;
			const o = { ...(option as Record<string, unknown>) };
			for (const key of ["pros", "cons"]) if (o[key] !== undefined) o[key] = toList(o[key]);
			for (const key of ["effort", "risk"]) o[key] = toLevel(o[key]);
			for (const key of Object.keys(o)) if (o[key] === null) delete o[key];
			return o;
		});
	if (typeof record.total === "string") record.total = toLevel(record.total);
	return record as DecideInput;
}

export type DecideOutcome = "chosen" | "own" | "asked" | "closed" | "no-ui";

export interface DecideDetails {
	id: string;
	question: string;
	outcome: DecideOutcome;
	/** Option id the user chose, also for their own option. */
	chosen?: string;
	/** Title of the chosen option. */
	title?: string;
	comment?: string;
	/** What the user asked instead of choosing. */
	asked?: string;
	recommended?: string;
	/** 1-based position, and the expected number of decisions when the agent said. */
	index: number;
	total?: number;
}

export interface DecideDeps {
	state(): ArchitectState;
	append(event: EventInput): void;
	ui: DecisionUi;
}

export interface DecideResult {
	content: { type: "text"; text: string }[];
	details: DecideDetails;
	terminate?: boolean;
}

const clean = (items: readonly string[] | undefined) => (items ?? []).map((s) => s.trim()).filter(Boolean);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The decision the input describes, with its id. Throws with a message for the model when the input is unusable. */
export function planDecision(state: ArchitectState, input: DecideInput): Decision {
	const arch = state.architecture;
	if (state.mode !== "architect" || !arch)
		throw new Error("architect_decide only works in architect mode. The user switches with /architect.");
	if (arch.approvedAt !== undefined) throw new Error("The plan is approved and final. Nothing can change now.");
	if (arch.phase !== "decide")
		throw new Error(
			`architect_decide belongs to the Decide phase. Now in ${PHASE_LABEL[arch.phase]}: ask the user in chat, or note the question as a risk for Decide.`,
		);

	const question = input.question.trim();
	if (!question) throw new Error("The decision needs a question.");
	const options: DecisionOption[] = input.options.map((o, i) => {
		const title = o.title.trim();
		if (!title) throw new Error("Every option needs a title.");
		const summary = o.summary?.trim();
		return {
			id: LETTERS[i]!,
			title,
			...(summary ? { summary } : {}),
			pros: clean(o.pros),
			cons: clean(o.cons),
			effort: o.effort as Level,
			risk: o.risk as Level,
		};
	});
	if (options.length < 2 || options.length > 4) throw new Error("Give 2 to 4 options.");
	const wanted = input.recommended.trim();
	const recommended =
		options.find((o) => same(o.id, wanted)) ??
		options.find((o) => same(o.title, wanted)) ??
		options[Number(wanted) - 1];
	if (!recommended) throw new Error(`Recommend one of the options by letter: ${options.map((o) => o.id).join(", ")}.`);

	let id: string;
	if (input.id) {
		const old = arch.decisions.find((d) => d.id === input.id!.trim());
		if (!old)
			throw new Error(
				`Unknown decision ${input.id}. Decisions: ${arch.decisions.map((d) => d.id).join(", ") || "none"}. Omit id for a new one.`,
			);
		id = old.id;
	} else {
		const open = arch.decisions.find((d) => d.chosen === undefined && same(d.question, question));
		id =
			open?.id ??
			nextId(
				arch.decisions.map((d) => d.id),
				"q",
			);
	}
	const context = input.context?.trim();
	const reason = input.reason.trim();
	return {
		id,
		question,
		...(context ? { context } : {}),
		options,
		recommendation: recommended.id,
		...(reason ? { reason } : {}),
	};
}

/** Short, one-line title for an option the user wrote. The full text goes in the summary. */
export function ownOption(decision: Decision, text: string): DecisionOption {
	const first = text.split("\n")[0]!.trim();
	const title = first.length > 48 ? `${first.slice(0, 47).trimEnd()}…` : first;
	const used = new Set(decision.options.map((o) => o.id));
	const id = LETTERS.find((l) => !used.has(l)) ?? `X${decision.options.length + 1}`;
	return {
		id,
		title,
		...(title !== text ? { summary: text } : {}),
		pros: [],
		cons: [],
		effort: 3,
		risk: 3,
		byUser: true,
	};
}

const result = (text: string, details: DecideDetails, terminate = false): DecideResult => ({
	content: [{ type: "text", text }],
	details,
	...(terminate ? { terminate } : {}),
});

/**
 * Raise one decision and wait for the user's answer on the decision card. The decision is recorded first,
 * so it shows as open even when the card is closed. The result tells the model what the user said and
 * what to do next.
 */
export async function decide(
	deps: DecideDeps,
	params: DecideInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<DecideResult> {
	const decision = planDecision(deps.state(), params);
	deps.append({ type: "decision", decision });
	const arch = deps.state().architecture!;
	const index = arch.decisions.findIndex((d) => d.id === decision.id) + 1;
	const base: Omit<DecideDetails, "outcome"> = {
		id: decision.id,
		question: decision.question,
		index,
		recommended: decision.recommendation!,
		...(params.total ? { total: Math.max(params.total, index) } : {}),
	};

	if (!ctx.hasUI)
		return result(
			`Nobody can answer here: this Pi session has no interactive UI. Decision ${decision.id} is recorded and open. Put the question, the options and your recommendation to the user in chat, and stop.`,
			{ ...base, outcome: "no-ui" },
			true,
		);

	const answer: DecisionAnswer | undefined = await deps.ui(
		{
			decision,
			index,
			...(base.total ? { total: base.total } : {}),
			...(arch.feature ? { feature: arch.feature } : {}),
			...(signal ? { signal } : {}),
		},
		ctx,
	);

	if (!answer || signal?.aborted)
		return result(
			`The user closed decision ${decision.id} without choosing. It stays open. Ask how to continue, and call architect_decide with id "${decision.id}" when they are ready.`,
			{ ...base, outcome: "closed" },
			true,
		);

	if (answer.kind === "ask")
		return result(
			`The user asked about decision ${decision.id} instead of choosing: "${answer.question}". Answer briefly in chat, then call architect_decide again with id "${decision.id}". Revise the options if your answer changes them.`,
			{ ...base, outcome: "asked", asked: answer.question },
		);

	let chosen: DecisionOption;
	let comment: string | undefined;
	let answered = decision;
	if (answer.kind === "own") {
		chosen = ownOption(decision, answer.text);
		answered = { ...decision, options: [...decision.options, chosen] };
		deps.append({ type: "decision", decision: answered });
	} else {
		chosen = decision.options.find((o) => o.id === answer.option)!;
		comment = answer.comment?.trim() || undefined;
	}
	deps.append({
		type: "choice",
		id: decision.id,
		chosen: chosen.id,
		...(comment ? { comment } : {}),
		snapshot: choiceSnapshot(answered),
	});

	const open = deps
		.state()
		.architecture!.decisions.filter((d) => d.chosen === undefined)
		.map((d) => d.id);
	const next = open.length
		? `Still open: ${open.join(", ")}.`
		: "Raise the next open question, or call architect_advance when every decision is made.";
	const details: DecideDetails = {
		...base,
		outcome: answer.kind === "own" ? "own" : "chosen",
		chosen: chosen.id,
		title: chosen.title,
		...(comment ? { comment } : {}),
	};
	if (answer.kind === "own")
		return result(
			`The user chose their own option for ${decision.id}: "${answer.text}". It is recorded as option ${chosen.id}. Treat it as decided. If it has a serious problem, say so in one or two sentences. ${next}`,
			details,
		);
	const deviates = chosen.id !== decision.recommendation ? ` (you recommended ${decision.recommendation})` : "";
	const said = comment ? ` and said: "${comment}". Follow what they said` : "";
	return result(`The user chose ${chosen.id} "${chosen.title}" for ${decision.id}${deviates}${said}. ${next}`, details);
}

const textOf = (content: readonly { type: string; text?: string }[]) =>
	content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");

/** Register `architect_decide`. Inactive by default, like every architect tool; architect mode turns it on. */
export function registerDecideTool(pi: ExtensionAPI, deps: DecideDeps): void {
	pi.registerTool({
		name: "architect_decide",
		label: "Architect decide",
		description:
			"Show the user one open question of the Decide phase as a decision card, and wait. Give 2 to 4 real " +
			"alternatives with pros, cons, effort and risk (1 to 5), and recommend one. Returns the user's choice and " +
			"comment, their own option, or a question they asked instead; then answer it and ask again with the same id.",
		promptSnippet: "Show the user an architecture decision with options and wait for their choice",
		promptGuidelines: [
			"Use architect_decide in the Decide phase for each open question, one call at a time. Do not list the options in chat as well.",
			"Give architect_decide real alternatives a senior engineer would weigh, rate effort and risk honestly, and recommend one.",
		],
		parameters: DecideParams,
		defaultActive: false,
		executionMode: "sequential",
		prepareArguments: prepareDecideArgs,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return decide(deps, params, signal, ctx);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(decideCall(args, theme as Paint));
			return text;
		},
		renderResult(result, { isPartial, expanded }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				decideResult(
					result.details as DecideDetails | undefined,
					textOf(result.content),
					isPartial,
					expanded,
					theme as Paint,
				),
			);
			return text;
		},
	});
}

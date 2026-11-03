import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Decision } from "./state/types.ts";

export interface DecisionRequest {
	decision: Decision;
	/** 1-based position of this decision among all decisions, for "Decision 3/5". */
	index?: number;
	/** How many decisions the agent expects, when it said. */
	total?: number;
	feature?: string;
	/** Aborts when the user interrupts the agent. Close the card when it fires. */
	signal?: AbortSignal;
}

/**
 * The user's answer on a decision card: an option (with an optional comment), their own option,
 * or a question for the agent instead of a choice.
 */
export type DecisionAnswer =
	| { kind: "choose"; option: string; comment?: string }
	| { kind: "own"; text: string }
	| { kind: "ask"; question: string };

/**
 * Shows a decision and waits for the user. Undefined means the user closed it without an answer.
 * `architect_decide` does the bookkeeping around it.
 */
export type DecisionUi = (request: DecisionRequest, ctx: ExtensionContext) => Promise<DecisionAnswer | undefined>;

export const OWN_OPTION = "✎ My own option";
export const ASK_FIRST = "? Ask a question first";

/** The decision as text lines, for the simple dialog. */
export function decisionLines(decision: Decision): string[] {
	const lines = [decision.question];
	if (decision.context) lines.push(decision.context);
	for (const o of decision.options) {
		const star = o.id === decision.recommendation ? " ★" : "";
		lines.push("", `${o.id}  ${o.title}${star} · effort ${o.effort}/5 · risk ${o.risk}/5`);
		if (o.summary) lines.push(`   ${o.summary}`);
		for (const pro of o.pros) lines.push(`   + ${pro}`);
		for (const con of o.cons) lines.push(`   − ${con}`);
	}
	const recommended = decision.options.find((o) => o.id === decision.recommendation);
	if (recommended)
		lines.push("", `★ Agent recommends ${recommended.id}${decision.reason ? `: ${decision.reason}` : ""}`);
	return lines;
}

/** Option labels for the simple dialog, in order. */
export const optionLabels = (decision: Decision) =>
	decision.options.map((o) => `${o.id}  ${o.title}${o.id === decision.recommendation ? " ★" : ""}`);

/** A plain decision dialog for RPC clients: the options in a select, then an input for an own option or a question. */
export const selectDecision: DecisionUi = async ({ decision, signal }, ctx) => {
	const opts = signal ? { signal } : undefined;
	const labels = optionLabels(decision);
	const choice = await ctx.ui.select(decisionLines(decision).join("\n"), [...labels, OWN_OPTION, ASK_FIRST], opts);
	if (choice === undefined) return undefined;
	if (choice === OWN_OPTION || choice === ASK_FIRST) {
		const own = choice === OWN_OPTION;
		const text = (
			await ctx.ui.input(own ? "Your own option" : "Your question for the agent", own ? "describe it" : "ask", opts)
		)?.trim();
		if (!text) return undefined;
		return own ? { kind: "own", text } : { kind: "ask", question: text };
	}
	const option = decision.options[labels.indexOf(choice)];
	return option ? { kind: "choose", option: option.id } : undefined;
};

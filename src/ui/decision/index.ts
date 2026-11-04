import { selectDecision, type DecisionAnswer, type DecisionUi } from "../../decision.ts";
import { screenOptions, type ScreenUiOptions } from "../screen-options.ts";
import type { Paint } from "../paint.ts";
import { DecisionCard } from "./component.ts";

export { DecisionCard } from "./component.ts";
export { renderDecision, type DecisionView } from "./card.ts";

/**
 * The decision card, inline in place of the editor so the transcript stays in view and terminals can show
 * Pi as waiting for the user. RPC and other non-terminal modes get the simple select dialog.
 * `options` sets the clock and length of the input grace period after the card opens, and how `b` opens
 * the board.
 */
export const createDecisionCard =
	(options: ScreenUiOptions = {}): DecisionUi =>
	async (request, ctx) => {
		if (ctx.mode !== "tui") return selectDecision(request, ctx);
		const { signal } = request;
		return ctx.ui.custom<DecisionAnswer | undefined>(
			(tui, theme, _keybindings, done) => {
				let finished = false;
				const finish = (answer: DecisionAnswer | undefined) => {
					if (finished) return;
					finished = true;
					signal?.removeEventListener("abort", abort);
					done(answer);
				};
				const abort = () => finish(undefined);
				if (signal?.aborted) queueMicrotask(abort);
				else signal?.addEventListener("abort", abort, { once: true });
				return new DecisionCard(tui, theme as Paint, request, finish, screenOptions(options, ctx));
			},
			{ blocked: { kind: "question", message: request.decision.question } },
		);
	};

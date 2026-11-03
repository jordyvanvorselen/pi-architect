import { selectReview, type ReviewAnswer, type ReviewUi } from "../../review.ts";
import { PHASE_LABEL, type Phase } from "../../state/phases.ts";
import type { GraceOptions } from "../grace.ts";
import type { Paint } from "../paint.ts";
import { blueprintBody } from "./blueprint.ts";
import type { ReviewBody } from "./common.ts";
import { ReviewScreen } from "./component.ts";
import { decideBody } from "./decide.ts";
import { designBody } from "./design.ts";
import { exploreBody } from "./explore.ts";
import { frameBody } from "./frame.ts";
import { sliceBody } from "./slice.ts";

export type { ReviewBody } from "./common.ts";
export { ReviewScreen } from "./component.ts";
export { renderReview, type ReviewView } from "./screen.ts";

/** The body of each phase's review screen. */
export const REVIEW_BODIES: Record<Phase, ReviewBody> = {
	frame: frameBody,
	explore: exploreBody,
	decide: decideBody,
	design: designBody,
	slice: sliceBody,
	blueprint: blueprintBody,
};

/**
 * The Phase Review screen, inline in place of the editor so the transcript stays in view and terminals can
 * show Pi as waiting for the user. `bodies` replaces the body of some phases, e.g. the Blueprint.
 * `grace` sets the clock and length of the input grace period after the screen opens.
 * RPC and other non-terminal modes get the simple select dialog.
 */
export function createPhaseReview(bodies: Partial<Record<Phase, ReviewBody>> = {}, grace: GraceOptions = {}): ReviewUi {
	const all = { ...REVIEW_BODIES, ...bodies };
	return async (request, ctx) => {
		if (ctx.mode !== "tui") return selectReview(request, ctx);
		const { signal } = request;
		return ctx.ui.custom<ReviewAnswer | undefined>(
			(tui, theme, _keybindings, done) => {
				let finished = false;
				const finish = (answer: ReviewAnswer | undefined) => {
					if (finished) return;
					finished = true;
					signal?.removeEventListener("abort", abort);
					done(answer);
				};
				const abort = () => finish(undefined);
				if (signal?.aborted) queueMicrotask(abort);
				else signal?.addEventListener("abort", abort, { once: true });
				return new ReviewScreen(tui, theme as Paint, request, all[request.phase], finish, grace);
			},
			{ blocked: { kind: "question", message: `Review ${PHASE_LABEL[request.phase]}` } },
		);
	};
}

/** The default review screen. */
export const phaseReview: ReviewUi = createPhaseReview();

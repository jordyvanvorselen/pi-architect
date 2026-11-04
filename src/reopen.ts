import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewUi } from "./review.ts";
import { PHASE_LABEL, type Phase } from "./state/phases.ts";
import { missing } from "./state/queries.ts";
import type { ArchitectState } from "./state/types.ts";
import { advance, type AdvanceDeps } from "./tools/advance.ts";

/** The message that tells the agent the verdict of a review the user opened with `/architect review`. */
export const REVIEW_MESSAGE = "architect-review";

/** How the user opens a review again. */
export const REOPEN_HINT = "/architect review opens it again";

/**
 * `/architect review`: the review of the current phase, opened by the user, e.g. after esc closed it.
 *
 * Closing a review without a verdict stops the agent. This remembers what the agent asked the user to
 * check, tells the user how to reopen, and opens the same review again on `/architect review`. The verdict
 * goes to the agent as a message that starts its next turn, with what `architect_advance` would have said.
 */
export class Reviews {
	private closed: { phase: Phase; summary?: string } | undefined;

	/** Forget the closed review, when the architecture or the branch changes under it. */
	clear(): void {
		this.closed = undefined;
	}

	/** `ui`, remembering a review the user closed without a verdict. */
	wrap(ui: ReviewUi): ReviewUi {
		return async (request, ctx) => {
			const answer = await ui(request, ctx);
			if (answer || request.signal?.aborted) this.closed = undefined;
			else {
				this.closed = { phase: request.phase, ...(request.summary ? { summary: request.summary } : {}) };
				if (ctx.hasUI) ctx.ui.notify(`${PHASE_LABEL[request.phase]} review closed. ${REOPEN_HINT}.`, "info");
			}
			return answer;
		};
	}

	/** Whether there is a phase to review: architect mode, not approved, not in review and complete. */
	canReview(state: ArchitectState): boolean {
		const arch = state.architecture;
		return (
			state.mode === "architect" &&
			arch !== undefined &&
			arch.approvedAt === undefined &&
			arch.status !== "review" &&
			missing(arch).length === 0
		);
	}

	/** Open the review of the current phase and hand the verdict to the agent with `send`. */
	async reopen(deps: AdvanceDeps, ctx: ExtensionContext, send: (text: string) => void): Promise<void> {
		const state = deps.state();
		const arch = state.architecture;
		if (state.mode !== "architect" || !arch || arch.approvedAt !== undefined) {
			ctx.ui.notify("There is no phase to review. /architect <feature> starts an architecture.", "info");
			return;
		}
		const label = PHASE_LABEL[arch.phase];
		if (arch.status === "review") {
			ctx.ui.notify(`The ${label} review is already open.`, "info");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify(`The agent is working. It opens the ${label} review when the phase is ready.`, "info");
			return;
		}
		const summary = this.closed?.phase === arch.phase ? this.closed.summary : undefined;
		const result = await advance(deps, summary ? { summary } : {}, undefined, ctx);
		const { outcome } = result.details;
		if (outcome === "not-ready") {
			const gaps = result.details.missing ?? [];
			ctx.ui.notify(`${label} is not ready for review yet. It still needs ${gaps.join(", ")}.`, "info");
			return;
		}
		if (outcome !== "approved" && outcome !== "changes") return;
		const text = result.content.map((c) => c.text).join("\n");
		send(`The user opened the ${label} review again with /architect review.\n${text}`);
	}
}

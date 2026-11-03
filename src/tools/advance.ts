import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { diagramRules, phaseGuidance, type ToolCheck } from "../prompt.ts";
import type { ReviewUi } from "../review.ts";
import type { EventInput } from "../state/events.ts";
import { nextPhase, PHASE_LABEL, PHASES, phaseIndex, type Phase } from "../state/phases.ts";
import { missing } from "../state/queries.ts";
import type { ArchitectState } from "../state/types.ts";

export const AdvanceParams = Type.Object(
	{
		summary: Type.Optional(
			Type.String({ description: "One or two sentences for the reviewer: what this phase settled and what to check." }),
		),
	},
	{ additionalProperties: false },
);

export type AdvanceInput = Static<typeof AdvanceParams>;

export type AdvanceOutcome = "approved" | "changes" | "closed" | "not-ready" | "no-ui";

export interface AdvanceDetails {
	phase: Phase;
	outcome: AdvanceOutcome;
	next?: Phase;
	comment?: string;
	missing?: string[];
	/** True when approving this phase made the plan final. */
	final?: boolean;
	/** Where the plan file was written, when it was. */
	planPath?: string;
}

/** What writing the plan file gave: the path, or why it failed. */
export type Finalized = { path: string } | { error: string };

export interface AdvanceDeps {
	state(): ArchitectState;
	append(event: EventInput): void;
	review: ReviewUi;
	now(): number;
	has: ToolCheck;
	/** Writes the plan file once the Blueprint is approved. */
	finalize?(ctx: ExtensionContext): Promise<Finalized>;
	/** Where approving the Blueprint will write the plan file, for the review screen. */
	planTarget?(ctx: ExtensionContext): string | undefined;
}

export interface AdvanceResult {
	content: { type: "text"; text: string }[];
	details: AdvanceDetails;
	isError?: boolean;
	terminate?: boolean;
}

const result = (text: string, details: AdvanceDetails, extra: Partial<AdvanceResult> = {}): AdvanceResult => ({
	content: [{ type: "text", text }],
	details,
	...extra,
});

/**
 * The phase gate. Checks the phase is complete, records the submit, waits for the review UI and records
 * the answer. The result tells the model what to do next, including the guidance for the next phase,
 * because the system prompt only updates at the start of the next run.
 */
export async function advance(
	deps: AdvanceDeps,
	params: AdvanceInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<AdvanceResult> {
	const state = deps.state();
	const arch = state.architecture;
	if (state.mode !== "architect" || !arch)
		throw new Error("architect_advance only works in architect mode. The user switches with /mode architect.");
	const phase = arch.phase;
	const label = PHASE_LABEL[phase];
	if (arch.approvedAt !== undefined) throw new Error("The plan is already approved. There is no next phase.");

	const gaps = missing(arch, deps.has);
	if (gaps.length)
		return result(
			`${label} is not ready for review. It still needs ${gaps.join(", ")}. Add it, then call architect_advance again.`,
			{ phase, outcome: "not-ready", missing: gaps },
			{ isError: true },
		);

	if (!ctx.hasUI)
		return result(
			`Nobody can review ${label} here: this Pi session has no interactive UI. Summarize ${label} for the user and stop.`,
			{ phase, outcome: "no-ui" },
			{ terminate: true },
		);

	const summary = params.summary?.trim();
	const planPath = phase === "blueprint" ? deps.planTarget?.(ctx) : undefined;
	deps.append({ type: "submit", phase, at: deps.now(), ...(summary ? { summary } : {}) });
	const answer = await deps
		.review(
			{
				arch: deps.state().architecture!,
				phase,
				...(summary ? { summary } : {}),
				...(signal ? { signal } : {}),
				...(planPath ? { planPath } : {}),
			},
			ctx,
		)
		.catch((error: unknown) => {
			deps.append({ type: "withdraw", phase, at: deps.now() });
			throw error;
		});

	if (!answer || signal?.aborted) {
		deps.append({ type: "withdraw", phase, at: deps.now() });
		return result(
			`The user closed the ${label} review without a decision. Ask how to continue, and call architect_advance again when they are ready.`,
			{ phase, outcome: "closed" },
			{ terminate: true },
		);
	}

	const comment = answer.comment?.trim();
	deps.append({ type: "verdict", phase, verdict: answer.verdict, at: deps.now(), ...(comment ? { comment } : {}) });

	if (answer.verdict === "changes")
		return result(
			comment
				? `The user requested changes to ${label}: "${comment}". Revise ${label}, then call architect_advance again.`
				: `The user requested changes to ${label} without a comment. Ask what should change.`,
			{ phase, outcome: "changes", ...(comment ? { comment } : {}) },
		);

	const next = nextPhase(phase);
	const note = comment ? ` The user added: "${comment}".` : "";
	if (!next) {
		const written = deps.finalize ? await deps.finalize(ctx) : undefined;
		const where = !written
			? ""
			: "path" in written
				? ` It is saved at ${written.path}.`
				: ` Writing the plan file failed: ${written.error}. The user can retry with /plan write.`;
		return result(
			`The user approved the Blueprint. The plan is final.${note}${where} Tell the user they can build it with /plan, or switch to build mode with /mode build.`,
			{
				phase,
				outcome: "approved",
				final: true,
				...(comment ? { comment } : {}),
				...(written && "path" in written ? { planPath: written.path } : {}),
			},
		);
	}
	const guidance = phaseGuidance(next, deps.has, deps.state().architecture).map((line) => `- ${line}`);
	return result(
		[
			`${label} approved.${note} Now in ${PHASE_LABEL[next]} (phase ${phaseIndex(next) + 1}/${PHASES.length}):`,
			...guidance,
			...diagramRules(next, deps.has),
		].join("\n"),
		{ phase, outcome: "approved", next, ...(comment ? { comment } : {}) },
	);
}

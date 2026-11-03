import type { PlanRef } from "../state/types.ts";
import { isDone, type SliceProgress } from "./progress.ts";

/** The first message of a build session, and what "Build it here" sends. */
export function kickoff(path: string): string {
	return `Build the plan at ${path}. Read the whole file first, then follow its "How to build this plan" section.`;
}

/**
 * The system prompt section in build mode while a plan is unfinished. Two lines, so the builder knows
 * where the plan is and that ticking its boxes is how the user sees progress. Undefined once all is done.
 */
export function buildSection(plan: PlanRef, progress: readonly SliceProgress[] | undefined): string | undefined {
	if (progress?.length && progress.every(isDone)) return undefined;
	return [
		`The user approved a plan for "${plan.feature || plan.slug}" at ${plan.path}. When you build it, follow its "How to build this plan" section.`,
		"Tick each box in the plan file with the edit tool as soon as the step is done. The user sees the progress from those boxes.",
	].join("\n");
}

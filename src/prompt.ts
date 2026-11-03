import { PHASE_LABEL, PHASES, phaseIndex, type Phase } from "./state/phases.ts";
import type { Architecture, ArchitectState, Mode } from "./state/types.ts";

/** Name of the system prompt section pi-architect owns. Pi wraps it in `<architect>` tags. */
export const SECTION = "architect";

/** `customType` of the message that tells the model about a mode switch. */
export const MODE_MESSAGE = "architect-mode";

/** Tool names, so guidance can mention a tool only when it is registered. */
export type ToolCheck = (name: string) => boolean;

/** What to do in a phase, in a few short lines. Mentions later tools only when they exist. */
export function phaseGuidance(phase: Phase, has: ToolCheck, arch?: Architecture): string[] {
	switch (phase) {
		case "frame":
			return [
				...(arch && !arch.feature
					? [
							"The feature has no name yet. The user's message describes it. Name it with architect_update({ feature }).",
						]
					: []),
				"Pin down the goal, constraints, out of scope and done-when. Ask the user about anything unclear instead of guessing.",
				"Read only the code you need to understand the request. Record the brief with architect_update({ brief }).",
			];
		case "explore":
			return [
				"Read the code this feature touches. Do not design yet.",
				"Record modules with architect_update({ modules }): touched (changes), new (does not exist yet) or context (read only).",
				"Record key findings and existing patterns with architect_update({ findings }).",
			];
		case "decide":
			return [
				has("architect_decide")
					? "Raise each open question with architect_decide: 2 to 4 options with pros, cons, effort, risk and one recommendation. It waits for the user's choice."
					: "Ask the user each open question, one at a time: 2 to 4 options with pros, cons, effort and risk, and your recommendation. Wait for each answer.",
				"Do not reopen a decided question unless the user asks.",
			];
		case "design":
			return [
				has("architect_diagram")
					? "Draw the components, the data flow and the key sequences as Unicode diagrams with architect_diagram. Mark parts [new], [changed] or [removed]."
					: "Describe the components, the data flow and the key sequences in a few short paragraphs.",
			];
		case "slice":
			return [
				has("architect_slice")
					? "Split the work into buildable slices with architect_slice: title, dependencies, files, steps and verify commands."
					: "Split the work into buildable slices: title, dependencies, files, steps and the commands that verify each one.",
				"Each slice must be buildable and verifiable on its own.",
			];
		case "blueprint":
			return [
				"Check the whole design for gaps and contradictions, and fix them.",
				"Then call architect_advance. Approving the Blueprint makes the plan final.",
			];
	}
}

function position(phase: Phase): string {
	return `Phase ${phaseIndex(phase) + 1}/${PHASES.length}: ${PHASE_LABEL[phase]}`;
}

const RULES = [
	"Architect mode is read-only: edit and write are off, and bash runs only read-only commands.",
	"When the phase is complete, call architect_advance. The user reviews the phase and you wait. Never skip a phase.",
	"The extension shows the design on screen, so keep chat short.",
];

/** The system prompt section for architect mode, or undefined in build mode. */
export function architectSection(state: ArchitectState, has: ToolCheck): string | undefined {
	const arch = state.architecture;
	if (state.mode !== "architect" || !arch) return undefined;
	const feature = arch.feature ? `"${arch.feature}"` : "not named yet";
	const head = `You are in architect mode, designing one feature before anyone builds it. Feature: ${feature}.`;
	if (arch.approvedAt !== undefined)
		return [
			head,
			"The user approved the Blueprint, so the plan is final. Answer questions about it.",
			"The user switches to build mode with /mode build to build it.",
			RULES[0],
		].join("\n");
	const status =
		arch.status === "review"
			? [`${position(arch.phase)}, waiting for review. Call architect_advance to reopen it.`]
			: [];
	return [
		head,
		...(status.length ? status : [`${position(arch.phase)}.`]),
		...phaseGuidance(arch.phase, has, arch).map((line) => `- ${line}`),
		"Rules:",
		...RULES.map((line) => `- ${line}`),
	].join("\n");
}

/** What the model hears, once, after the user switched mode. */
export function modeNotice(mode: Mode, arch: Architecture | undefined): string {
	if (mode === "architect") {
		const where = arch && arch.approvedAt === undefined ? ` Current phase: ${PHASE_LABEL[arch.phase]}.` : "";
		return `[pi-architect] The user switched to architect mode. It is read-only: edit and write are off.${where}`;
	}
	const plan = arch?.approvedAt !== undefined ? " Build from the approved plan." : "";
	return `[pi-architect] The user switched to build mode. All tools are back and the architect tools are off.${plan}`;
}

/** The mode the model last heard about on this branch. Build until told otherwise. */
export function modeToldToModel(entries: readonly { type: string; customType?: string; details?: unknown }[]): Mode {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "custom_message" || entry.customType !== MODE_MESSAGE) continue;
		const mode = (entry.details as { mode?: unknown } | undefined)?.mode;
		if (mode === "architect" || mode === "build") return mode;
	}
	return "build";
}

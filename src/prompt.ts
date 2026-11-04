import { diagramGuide, diagramMaxWidth } from "./diagram/guide.ts";
import { ENTRY_TYPE } from "./state/events.ts";
import { isPhase, nextPhase, PHASE_LABEL, PHASES, phaseIndex, type Phase } from "./state/phases.ts";
import { textOf } from "./tools/common.ts";
import type { Architecture, ArchitectState, Mode } from "./state/types.ts";

/** Name of the system prompt section pi-architect owns. Pi wraps it in `<architect>` tags. */
export const SECTION = "architect";

/** `customType` of the message that tells the model about a mode switch. */
export const MODE_MESSAGE = "architect-mode";

/**
 * What to do in a phase, in a few short lines. Each line names only tools that are active in that phase:
 * the extension turns them on and off with the phase.
 */
export function phaseGuidance(phase: Phase, arch?: Architecture): string[] {
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
				"Record key findings and existing patterns with architect_update({ findings }). Sketch the current architecture with architect_diagram when a picture helps.",
			];
		case "decide":
			return [
				"Raise open questions one at a time with architect_decide: 2 to 4 real alternatives, honest effort and risk (1 to 5), and one recommendation with a reason.",
				"It waits for the user. If they ask a question instead, answer it briefly, then call architect_decide again with the same id.",
				"Do not reopen a decided question unless the user asks.",
			];
		case "design":
			return [
				"Draw the components, the data flow and the key sequences as Unicode diagrams with architect_diagram. Mark parts [new], [changed] or [removed].",
			];
		case "slice":
			return [
				"Split the work into buildable slices with architect_slice: id, title, goal, depends_on, files, steps and verify commands.",
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
	"The extension shows the design on screen, so keep chat short.",
];

export interface SectionOptions {
	/**
	 * The model already has the drawing rules for this phase, in the architect_advance result that opened it.
	 * The section then leaves them out instead of sending them again.
	 */
	drawingRulesInContext?: boolean;
}

/** The system prompt section for architect mode, or undefined in build mode. */
export function architectSection(state: ArchitectState, options: SectionOptions = {}): string | undefined {
	const arch = state.architecture;
	if (state.mode !== "architect" || !arch) return undefined;
	const feature = arch.feature ? `"${arch.feature}"` : "not named yet";
	const head = `You are in architect mode, designing one feature before anyone builds it. Feature: ${feature}.`;
	if (arch.approvedAt !== undefined)
		return [
			head,
			"The user approved the Blueprint, so the plan is final. Answer questions about it.",
			"The user switches to build mode with /architect build to build it.",
			RULES[0],
		].join("\n");
	const status =
		arch.status === "review"
			? `${position(arch.phase)}, waiting for review. Call architect_advance to reopen it.`
			: `${position(arch.phase)}.`;
	return [
		head,
		status,
		...phaseGuidance(arch.phase, arch).map((line) => `- ${line}`),
		"Rules:",
		...RULES.map((line) => `- ${line}`),
		...(options.drawingRulesInContext ? [] : diagramRules(arch.phase)),
	].join("\n");
}

/** Phases whose work is drawing diagrams. Later phases may still revise one; the tool result guides them then. */
const DRAWING_PHASES: readonly Phase[] = ["explore", "design"];

/** First line of the drawing rules, to find them in a tool result. */
export const DRAWING_RULES_HEAD = "Drawing diagrams for architect_diagram:";

/** How to draw diagrams the linter accepts, in the phases that draw them. */
export function diagramRules(phase: Phase): string[] {
	if (!DRAWING_PHASES.includes(phase)) return [];
	return [DRAWING_RULES_HEAD, diagramGuide(diagramMaxWidth())];
}

/** The parts of a session entry `drawingRulesInContext` reads. Pi's `SessionEntry` fits it. */
export interface ContextEntry {
	type: string;
	id?: string;
	customType?: string;
	data?: unknown;
	firstKeptEntryId?: string;
	message?: { role?: string; toolName?: string; content?: unknown; details?: unknown };
}

/**
 * Whether the architect_advance result that opened `phase` is on the branch and still in the model's
 * context, with the drawing rules in it. It is when the approval came from the tool, after the verdict
 * that opened the phase, and no compaction since dropped it.
 */
export function drawingRulesInContext(entries: readonly ContextEntry[], phase: Phase): boolean {
	let opened = -1;
	entries.forEach((e, i) => {
		const data = e.data as { type?: unknown; phase?: unknown; verdict?: unknown } | undefined;
		if (
			e.type === "custom" &&
			e.customType === ENTRY_TYPE &&
			data?.type === "verdict" &&
			data.verdict === "approved" &&
			isPhase(data.phase) &&
			nextPhase(data.phase) === phase
		)
			opened = i;
	});
	if (opened < 0) return false;
	const result = entries.findIndex((e, i) => {
		const m = e.message;
		if (i <= opened || e.type !== "message" || m?.role !== "toolResult" || m.toolName !== "architect_advance")
			return false;
		const text = Array.isArray(m.content) ? textOf(m.content as { type: string; text?: string }[]) : "";
		return (m.details as { next?: unknown } | undefined)?.next === phase && text.includes(DRAWING_RULES_HEAD);
	});
	if (result < 0) return false;
	for (const e of entries.slice(result + 1)) {
		if (e.type !== "compaction") continue;
		const kept = entries.findIndex((k) => k.id === e.firstKeptEntryId);
		if (kept < 0 || kept > result) return false;
	}
	return true;
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

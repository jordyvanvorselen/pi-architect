// `architect_diagram`: the model sends a Unicode diagram it drew. The linter checks it first: a drawing with
// alignment errors is rejected with findings the model can fix, so the user only sees diagrams that hold together.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	type DiagramFinding,
	diagramMaxWidth,
	type DiagramRepair,
	DiagramSchema,
	repairLines,
	validateDiagram,
} from "../diagram/index.ts";
import type { DiagramEvent } from "../state/events.ts";
import { PHASE_LABEL, phaseIndex, type Phase } from "../state/phases.ts";
import { missing, nextId } from "../state/queries.ts";
import type { Architecture, Diagram } from "../state/types.ts";
import { diagramCall, diagramResult } from "../ui/diagram.ts";
import { architecture, EXAMPLE_AFTER, parseJson, readiness, Rejections, type ToolDeps } from "./common.ts";

export const DiagramParams = Type.Object(
	{
		id: Type.Optional(
			Type.String({
				description: 'Id of a diagram to replace, e.g. "d2", to revise it after feedback. Omit to add one.',
			}),
		),
		...DiagramSchema.properties,
	},
	{ additionalProperties: false },
);

export type DiagramInput = Static<typeof DiagramParams>;

/** Phases with diagrams: Explore sketches what exists, Design draws the change, later phases fix gaps. */
export function diagramsAllowed(phase: Phase): boolean {
	return phaseIndex(phase) >= phaseIndex("explore");
}

const BODY_ALIASES = ["diagram", "drawing", "text", "content", "ascii", "unicode"];

/** Models send the drawing under another name, as a list of lines, or the whole call as a JSON string. */
export function prepareDiagramArgs(raw: unknown): DiagramInput {
	const args = parseJson(raw);
	if (!args || typeof args !== "object" || Array.isArray(args)) return {} as DiagramInput;
	const record: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) if (value !== null) record[key] = value;
	if (record.body === undefined) {
		const alias = BODY_ALIASES.find((k) => record[k] !== undefined);
		if (alias) {
			record.body = record[alias];
			delete record[alias];
		}
	}
	if (record.title === undefined && typeof record.name === "string") {
		record.title = record.name;
		delete record.name;
	}
	if (Array.isArray(record.body) && record.body.every((l) => typeof l === "string"))
		record.body = record.body.join("\n");
	return record as DiagramInput;
}

export type DiagramDetails =
	| {
			outcome: "saved";
			phase: Phase;
			diagram: Diagram;
			replaced: boolean;
			lines: number;
			cols: number;
			warnings: DiagramFinding[];
			/** Slips repaired before it was saved. */
			repairs: DiagramRepair[];
			missing: string[];
	  }
	| { outcome: "rejected"; phase: Phase; errors: number; warnings: number; findings: DiagramFinding[] };

type FindingKind = "box" | "arm" | "arrow" | "width" | "text";

/** The kind of a linter error, to notice the same mistake coming back. */
function findingKind(f: DiagramFinding): FindingKind {
	if (/box side|col off/.test(f.message)) return "box";
	if (/has nothing|does not join/.test(f.message)) return "arm";
	if (/gap between/.test(f.message)) return "arrow";
	if (/wider than/.test(f.message)) return "width";
	return "text";
}

/** What passes, for a kind of error the model made twice in a row. */
const PASSING: Record<FindingKind, string> = {
	box: "A box passes when its top, every text line and its bottom have the same width, so both sides stay in one column: ╭───────╮ / │ Panel │ / ╰───────╯. Pad short text lines with spaces up to the side.",
	arm: "A junction passes when every arm meets a line: ╰───┬───╯ with │ right below the ┬. Use ─ or │ instead where nothing joins.",
	arrow: "An arrow passes when it touches its line: ──────▶, with no space before the ▶.",
	width: "A diagram passes when every line fits the width: stack boxes top to bottom, or split it into two diagrams.",
	text: "Send plain text with spaces only: no tabs, no colour codes, and a short title.",
};

export interface DiagramPlan {
	/** Undefined when the diagram was rejected. */
	event: Omit<DiagramEvent, "v"> | undefined;
	text: string;
	details: DiagramDetails;
}

/**
 * Check the diagram and turn it into a `diagram` event, or a rejection with the linter's findings. Pure.
 * Throws for calls that cannot work at all: wrong phase, unknown id, approved plan.
 */
export function planDiagram(
	arch: Architecture,
	input: DiagramInput,
	options: { maxWidth?: number; rejections?: Rejections } = {},
): DiagramPlan {
	if (arch.approvedAt !== undefined) throw new Error("The plan is approved and final. Nothing can change now.");
	const phase = arch.phase;
	if (!diagramsAllowed(phase))
		throw new Error(
			`Diagrams start in Explore. You are in ${PHASE_LABEL[phase]}: finish the brief and call architect_advance first.`,
		);
	const id = input.id?.trim();
	const old = id ? arch.diagrams.find((d) => d.id === id) : undefined;
	if (id && !old)
		throw new Error(
			`There is no diagram ${id} to replace. Diagrams: ${arch.diagrams.map((d) => d.id).join(", ") || "none"}. Omit id to add one.`,
		);

	const check = validateDiagram(input, { maxWidth: options.maxWidth ?? diagramMaxWidth() });
	if (!check.ok || !check.diagram) {
		const kinds = [...new Set(check.findings.filter((f) => f.severity === "error").map(findingKind))];
		options.rejections?.record(kinds);
		const examples = kinds
			.filter((k) => (options.rejections?.count(k) ?? 0) >= EXAMPLE_AFTER)
			.map((k) => `- ${PASSING[k]}`);
		const again = examples.length
			? ["You made this kind of error in your last attempt too. What passes:", ...examples]
			: [];
		return {
			event: undefined,
			text: [check.summary, ...(old ? [`Keep id "${old.id}" to replace it.`] : []), ...again].join("\n"),
			details: {
				outcome: "rejected",
				phase,
				errors: check.errors,
				warnings: check.warnings,
				findings: check.findings,
			},
		};
	}
	options.rejections?.clear();

	const diagram: Diagram = {
		id:
			old?.id ??
			nextId(
				arch.diagrams.map((d) => d.id),
				"d",
			),
		// A revised diagram stays with the phase it was drawn for.
		phase: old?.phase ?? phase,
		title: check.diagram.title,
		body: check.diagram.body,
		...(check.diagram.caption ? { caption: check.diagram.caption } : {}),
	};
	const bodyLines = diagram.body.split("\n");
	const cols = Math.max(0, ...bodyLines.map((l) => visibleWidth(l)));
	const gaps = missing({ ...arch, diagrams: [...arch.diagrams.filter((d) => d.id !== diagram.id), diagram] });
	const next = readiness(phase, gaps);
	const warned = check.findings.filter((f) => f.severity === "warning");
	const warnings = warned.length
		? [
				"Warnings, fix them if you revise it:",
				...warned.map((f) => `- line ${f.line} col ${f.col} warning: ${f.message}`),
			]
		: [];
	const verb = old ? `Replaced diagram ${diagram.id}` : `Saved diagram ${diagram.id}`;
	const saved = `${verb} "${diagram.title}" (${bodyLines.length} lines, ${cols} cols). The user sees it on screen.`;
	return {
		event: { type: "diagram", diagram },
		text: [saved, ...repairLines(check.repairs, true), ...warnings, next].join("\n"),
		details: {
			outcome: "saved",
			phase,
			diagram,
			replaced: Boolean(old),
			lines: bodyLines.length,
			cols,
			warnings: warned,
			repairs: check.repairs,
			missing: gaps,
		},
	};
}

/** Register `architect_diagram`. */
export function registerDiagramTool(pi: ExtensionAPI, deps: ToolDeps): void {
	const rejections = new Rejections();
	pi.registerTool({
		name: "architect_diagram",
		label: "Architect diagram",
		description:
			"Show the user a Unicode diagram you drew (Explore and later): components, data flow, sequences, module maps. " +
			"It is checked for alignment first; when rejected, fix the findings and send it again. Give id to replace a diagram.",
		promptSnippet: "Show the user a Unicode diagram you drew of the architecture",
		promptGuidelines: [
			"Use architect_diagram for every architecture picture instead of drawing it in chat. Explore and Design come with drawing rules; a rejection lists every finding to fix.",
			"After feedback on a diagram, call architect_diagram again with its id to replace it.",
		],
		parameters: DiagramParams,
		defaultActive: false,
		prepareArguments: prepareDiagramArgs,
		async execute(_toolCallId, params) {
			const arch = architecture(deps.state(), "architect_diagram");
			const plan = planDiagram(arch, params, { rejections });
			if (!plan.event) return { content: [{ type: "text", text: plan.text }], details: plan.details, isError: true };
			deps.append(plan.event);
			return { content: [{ type: "text", text: plan.text }], details: plan.details };
		},
		renderCall(args, theme, context) {
			return diagramCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return diagramResult(result, options, theme, context);
		},
	});
}

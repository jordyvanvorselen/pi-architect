// `architect_diagram`: the model sends a Unicode diagram it drew. The linter checks it first: a drawing with
// alignment errors is rejected with findings the model can fix, so the user only sees diagrams that hold together.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { type DiagramFinding, diagramMaxWidth, DiagramSchema, validateDiagram } from "../diagram/index.ts";
import type { DiagramEvent, EventInput } from "../state/events.ts";
import { PHASE_LABEL, phaseIndex, type Phase } from "../state/phases.ts";
import { missing, nextId } from "../state/queries.ts";
import type { ArchitectState, Architecture, Diagram } from "../state/types.ts";
import { diagramCall, diagramResult } from "../ui/diagram.ts";

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

function parseJson(value: unknown): unknown {
	if (typeof value !== "string" || !/^\s*\{/.test(value)) return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
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
			missing: string[];
	  }
	| { outcome: "rejected"; phase: Phase; errors: number; warnings: number; findings: DiagramFinding[] };

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
	options: { maxWidth?: number; has?: (tool: string) => boolean } = {},
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
	if (!check.ok || !check.diagram)
		return {
			event: undefined,
			text: `${check.summary}${old ? ` Keep id "${old.id}" to replace it.` : ""}`,
			details: {
				outcome: "rejected",
				phase,
				errors: check.errors,
				warnings: check.warnings,
				findings: check.findings,
			},
		};

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
	const gaps = missing(
		{ ...arch, diagrams: [...arch.diagrams.filter((d) => d.id !== diagram.id), diagram] },
		options.has,
	);
	const label = PHASE_LABEL[phase];
	const next = gaps.length
		? `${label} still needs ${gaps.join(", ")}.`
		: `${label} is ready: call architect_advance when the user should review it.`;
	const warnings = check.warnings ? ` ${check.summary.split("\n").slice(1).join("\n")}` : "";
	const verb = old ? `Replaced diagram ${diagram.id}` : `Saved diagram ${diagram.id}`;
	return {
		event: { type: "diagram", diagram },
		text: `${verb} "${diagram.title}" (${bodyLines.length} lines, ${cols} cols). The user sees it on screen.${warnings ? ` Warnings, fix them if you revise it:${warnings}` : ""} ${next}`,
		details: {
			outcome: "saved",
			phase,
			diagram,
			replaced: Boolean(old),
			lines: bodyLines.length,
			cols,
			warnings: check.findings.filter((f) => f.severity === "warning"),
			missing: gaps,
		},
	};
}

export interface DiagramToolDeps {
	state(): ArchitectState;
	append(event: EventInput): void;
	has(tool: string): boolean;
}

/** Register `architect_diagram`. */
export function registerDiagramTool(pi: ExtensionAPI, deps: DiagramToolDeps): void {
	pi.registerTool({
		name: "architect_diagram",
		label: "Architect diagram",
		description:
			"Show the user a Unicode diagram you drew (Explore and later): components, data flow, sequences, module maps. " +
			"It is checked for alignment first; when rejected, fix the findings and send it again. Give id to replace a diagram.",
		promptSnippet: "Show the user a Unicode diagram you drew of the architecture",
		promptGuidelines: [
			"Use architect_diagram for every architecture picture instead of drawing it in chat. Follow the drawing rules in the phase guidance.",
			"After feedback on a diagram, call architect_diagram again with its id to replace it.",
		],
		parameters: DiagramParams,
		defaultActive: false,
		prepareArguments: prepareDiagramArgs,
		async execute(_toolCallId, params) {
			const state = deps.state();
			const arch = state.architecture;
			if (state.mode !== "architect" || !arch)
				throw new Error("architect_diagram only works in architect mode. The user switches with /architect.");
			const plan = planDiagram(arch, params, { has: deps.has });
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

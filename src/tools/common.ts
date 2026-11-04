// What the architect tools share: schema helpers, argument repair, the readiness note and the Text
// component their call and result rows reuse.
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { EventInput } from "../state/events.ts";
import { PHASE_LABEL, phaseIndex, type Phase } from "../state/phases.ts";
import type { ArchitectState, Architecture } from "../state/types.ts";

/** A list of strings in a tool schema. */
export const List = (description: string) => Type.Array(Type.String(), { description });

/** Models send objects and lists as JSON strings. Parse those; leave everything else as it is. */
export function parseJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!/^[[{]/.test(trimmed)) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

/** Trimmed items without the empty ones. */
export const clean = (items: readonly string[] | undefined): string[] =>
	(items ?? []).map((s) => s.trim()).filter(Boolean);

/** The text parts of a tool result, joined. */
export const textOf = (content: readonly { type: string; text?: string }[]) =>
	content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");

/**
 * The architect tools the model gets for an architecture, in the order it gets them. Every request carries
 * the schemas of the active tools, so a tool is only on in the phases where it works: update and advance
 * always, decide in Decide, diagram from Explore on and slice in Slice and Blueprint. Once the plan is
 * final nothing changes it, so only update and advance stay, to explain that.
 */
export function phaseTools(arch: Architecture | undefined): string[] {
	const tools = ["architect_update", "architect_advance"];
	if (!arch || arch.approvedAt !== undefined) return tools;
	const at = phaseIndex(arch.phase);
	if (arch.phase === "decide") tools.push("architect_decide");
	if (at >= phaseIndex("explore")) tools.push("architect_diagram");
	if (at >= phaseIndex("slice")) tools.push("architect_slice");
	return tools;
}

/** What every architect tool reads and writes. */
export interface ToolDeps {
	state(): ArchitectState;
	append(event: EventInput): void;
}

/** The open architecture, or the error a tool throws outside architect mode. */
export function architecture(state: ArchitectState, tool: string): Architecture {
	if (state.mode !== "architect" || !state.architecture)
		throw new Error(`${tool} only works in architect mode. The user switches with /architect.`);
	return state.architecture;
}

/** The last sentence of a tool result: what the phase still needs, or that it is ready for review. */
export function readiness(phase: Phase, gaps: readonly string[]): string {
	const label = PHASE_LABEL[phase];
	return gaps.length
		? `${label} still needs ${gaps.join(", ")}.`
		: `${label} is ready: call architect_advance when the user should review it.`;
}

/**
 * How often a tool rejected each kind of problem in a row. A model that keeps sending the same mistake
 * gets a concrete example of a value that passes, instead of the same sentence again.
 */
export class Rejections {
	private readonly counts = new Map<string, number>();

	/** Count one rejection of each kind. Kinds that did not come up again start over. */
	record(kinds: Iterable<string>): void {
		const now = new Set(kinds);
		for (const kind of [...this.counts.keys()]) if (!now.has(kind)) this.counts.delete(kind);
		for (const kind of now) this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
	}

	/** How many rejections in a row had this kind. */
	count(kind: string): number {
		return this.counts.get(kind) ?? 0;
	}

	/** The call passed. */
	clear(): void {
		this.counts.clear();
	}
}

/** From this many rejections of one kind in a row, the error shows what passes. */
export const EXAMPLE_AFTER = 2;

/**
 * A `renderCall` or `renderResult` that draws one text. Pi passes the component of the last render,
 * so the call row and the result row reuse one `Text`.
 */
export function textRow(context: { lastComponent?: unknown }, text: string): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(text);
	return component;
}

// What the architect tools share: schema helpers, argument repair, the readiness note and the Text
// component their call and result rows reuse.
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { EventInput } from "../state/events.ts";
import { PHASE_LABEL, type Phase } from "../state/phases.ts";
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
 * A `renderCall` or `renderResult` that draws one text. Pi passes the component of the last render,
 * so the call row and the result row reuse one `Text`.
 */
export function textRow(context: { lastComponent?: unknown }, text: string): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(text);
	return component;
}

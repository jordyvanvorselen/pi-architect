// Which tools are active in each mode and phase.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { allowedInArchitect } from "./readonly/index.ts";
import type { ArchitectState } from "./state/types.ts";
import { phaseTools } from "./tools/common.ts";

/** Tools only architect mode needs. Every tool named `architect_*` counts, so later tools join automatically. */
export const isArchitectTool = (name: string) => name.startsWith("architect_");

/** What build mode brings back when nothing recorded what architect mode turned off. */
const WRITE_TOOLS = ["edit", "write"];

/**
 * Make the active tools fit the mode and the phase. Architect mode turns off every tool the read-only
 * allowlist does not allow, so their schemas are not sent, and the architect tools of the current phase on
 * (see `phaseTools`). Build mode turns the architect tools off and exactly the tools architect mode turned
 * off back on. A reload keeps the current tools and turns on every extension tool, and a resume or /tree
 * restores the tool set from the transcript, so this works from the state alone and never from what it
 * turned off in memory.
 *
 * `record` remembers tools that turned on since architect mode started, e.g. MCP tools that registered late.
 */
export function applyTools(pi: ExtensionAPI, state: ArchitectState, record: (turnedOff: string[]) => void): void {
	const active = pi.getActiveTools();
	const all = new Set(pi.getAllTools().map((t) => t.name));
	let next: string[];
	if (state.mode === "architect") {
		const wanted = phaseTools(state.architecture).filter((n) => all.has(n));
		const kept = active.filter((n) => allowedInArchitect(n) && (!isArchitectTool(n) || wanted.includes(n)));
		next = [...new Set([...kept, ...wanted])];
		// Tools that turned on since, e.g. MCP tools that registered late: off too, and remembered.
		const known = new Set(state.turnedOff ?? []);
		const late = active.filter((n) => !allowedInArchitect(n) && !known.has(n));
		if (late.length) record(late);
	} else {
		// No record of what architect mode turned off, e.g. after /tree to before architect mode, while the
		// architect tools are still on: the set comes from architect mode, so the write tools come back.
		const leftover = state.turnedOff === undefined && active.some(isArchitectTool);
		const back = (state.turnedOff ?? (leftover ? WRITE_TOOLS : [])).filter((n) => all.has(n));
		next = [...new Set([...active.filter((n) => !isArchitectTool(n)), ...back])];
	}
	if (next.length !== active.length || next.some((n, i) => n !== active[i])) pi.setActiveTools(next);
}

/** What the active tools depend on. */
export const toolKey = (s: ArchitectState) =>
	s.mode === "architect" ? `architect:${phaseTools(s.architecture).join(",")}` : "build";

/** The active tools that entering architect mode turns off. */
export const turnedOffByArchitect = (pi: ExtensionAPI) => pi.getActiveTools().filter((n) => !allowedInArchitect(n));

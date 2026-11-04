// Which tools are active in each mode and phase.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ArchitectState } from "./state/types.ts";
import { phaseTools } from "./tools/common.ts";

/** Tools only architect mode needs. Every tool named `architect_*` counts, so later tools join automatically. */
export const isArchitectTool = (name: string) => name.startsWith("architect_");

/** What versions before 0.3 turned off in architect mode, when nothing recorded it. */
const WRITE_TOOLS = ["edit", "write"];

/**
 * Make the active tools fit the mode and the phase. Architect mode turns the architect tools of the current
 * phase on (see `phaseTools`) and leaves every other tool alone: the prompt tells the agent not to change
 * anything. Build mode turns the architect tools off. A reload turns on every extension tool, and a resume or
 * /tree restores the tool set from the transcript, so this works from the state alone.
 *
 * Versions before 0.3 turned off every tool outside a read-only allowlist and recorded them in `turnedOff`.
 * Both modes turn those tools back on, so a session from such a version gets them back.
 */
export function applyTools(pi: ExtensionAPI, state: ArchitectState): void {
	const active = pi.getActiveTools();
	const all = new Set(pi.getAllTools().map((t) => t.name));
	// No record of what an older architect mode turned off, e.g. after /tree to before it, while the architect
	// tools are still on: the set comes from that architect mode, so the write tools come back.
	const leftover = state.mode === "build" && state.turnedOff === undefined && active.some(isArchitectTool);
	const back = (state.turnedOff ?? (leftover ? WRITE_TOOLS : [])).filter((n) => all.has(n) && !isArchitectTool(n));
	const wanted = state.mode === "architect" ? phaseTools(state.architecture).filter((n) => all.has(n)) : [];
	const next = [...new Set([...active.filter((n) => !isArchitectTool(n) || wanted.includes(n)), ...back, ...wanted])];
	if (next.length !== active.length || next.some((n, i) => n !== active[i])) pi.setActiveTools(next);
}

/** What the active tools depend on. */
export const toolKey = (s: ArchitectState) =>
	s.mode === "architect" ? `architect:${phaseTools(s.architecture).join(",")}` : "build";

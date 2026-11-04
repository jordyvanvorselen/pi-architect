// How the extension's session entries show in the transcript. They never reach the model.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ENTRY_TYPE, type ArchitectEvent } from "./state/events.ts";
import type { ArchitectState } from "./state/types.ts";
import { choiceEntry, SpanView, verdictEntry } from "./ui/entries.ts";
import type { Paint } from "./ui/paint.ts";

/** Register the renderer of the extension's entries. `state` gives the decisions a choice refers to. */
export function registerEntryRenderer(pi: ExtensionAPI, state: () => ArchitectState): void {
	pi.registerEntryRenderer<ArchitectEvent>(ENTRY_TYPE, (entry, options, theme) => {
		const e = entry.data;
		const paint = theme as Paint;
		if (!e) return undefined;
		if (e.type === "mode")
			return new Text(
				e.mode === "architect"
					? `${paint.fg("accent", paint.bold("◆ architect mode"))}  ${paint.fg("dim", "read-only · the agent walks through the phases, you approve each one")}`
					: `${paint.fg("muted", paint.bold("▸ build mode"))}  ${paint.fg("dim", "all tools are back")}`,
				0,
				0,
			);
		if (e.type === "begin")
			return new Text(`${paint.fg("accent", "◆")} ${paint.fg("text", `architecting "${e.feature}"`)}`, 0, 0);
		if (e.type === "reset") return new Text(paint.fg("dim", "■ architecture discarded"), 0, 0);
		if (e.type === "choice") {
			const decision = state().architecture?.decisions.find((d) => d.id === e.id);
			return new SpanView(paint, choiceEntry(e, decision, options.expanded));
		}
		if (e.type === "verdict") return new SpanView(paint, verdictEntry(e, options.expanded));
		if (e.type === "plan")
			return new Text(
				`${paint.fg("success", "▣ plan")} ${paint.fg("text", e.path)}  ${paint.fg("dim", "/architect plan to build it")}`,
				0,
				0,
			);
		return undefined;
	});
}

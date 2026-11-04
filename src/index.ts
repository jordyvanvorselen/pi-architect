import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import type { DecisionUi } from "./decision.ts";
import { registerFlags } from "./flags.ts";
import { registerLifecycle } from "./lifecycle.ts";
import type { ReviewUi } from "./review.ts";
import { ArchitectSession } from "./session.ts";
import type { EventInput } from "./state/events.ts";
import { registerAdvanceTool } from "./tools/advance.ts";
import { registerDecideTool } from "./tools/decide.ts";
import { registerDiagramTool } from "./tools/diagram.ts";
import { registerSliceTool } from "./tools/slice.ts";
import { registerUpdateTool } from "./tools/update.ts";
import { registerEntryRenderer } from "./transcript.ts";
import { createDecisionCard } from "./ui/decision/index.ts";
import { createPhaseReview } from "./ui/review/index.ts";

export { KICKOFF_MESSAGE, SHORTCUT, SUBCOMMAND_NAMES } from "./commands.ts";
export { FLAG, flagHelp, HELP_COLUMN, PLAN_DIR_FLAG } from "./flags.ts";
export { ENTRY_TYPE } from "./state/events.ts";
export { isArchitectTool } from "./tools-activation.ts";
export { WIDGET_KEY } from "./widgets.ts";

/** Test seams. Pi calls the factory with `pi` only. */
export interface ArchitectOverrides {
	/** Replaces the phase review screen. */
	review?: ReviewUi;
	/** Replaces the decision card. */
	decide?: DecisionUi;
	/** The clock, for event times and the input grace period of the decision card and review screens. */
	now?: () => number;
	/** How long the decision card and review screens ignore ↵ after they open, in ms. Default 300. */
	inputGrace?: number;
	/** Where plan files go, relative to the cwd or absolute. Beats the flag. Default `docs/plans`. */
	planDir?: string;
	/** Copies text to the clipboard, for "Copy the path" in `/architect plan`. */
	copy?: (text: string) => Promise<void>;
	/** Opens a file in the default app, for `/architect plan open`. */
	open?: (file: string) => Promise<void>;
}

export default function architectExtension(pi: ExtensionAPI, overrides: ArchitectOverrides = {}): void {
	const now = overrides.now ?? Date.now;
	const session = new ArchitectSession(pi, {
		now,
		...(overrides.planDir !== undefined ? { planDir: overrides.planDir } : {}),
	});
	const grace = { now, ...(overrides.inputGrace !== undefined ? { graceMs: overrides.inputGrace } : {}) };
	// The review screens and decision cards open the board with `b`: Pi runs extension shortcuts only from
	// the main editor, so ctrl+alt+b does not reach them. Read-only there: the answer on the screen is the
	// way to give feedback, and the agent is waiting for it.
	const screens = {
		...grace,
		board: (ctx: ExtensionContext) => {
			session
				.showBoard(ctx, { readOnly: true })
				.catch((error: unknown) =>
					ctx.ui.notify(`Could not open the board: ${error instanceof Error ? error.message : String(error)}`, "error"),
				);
		},
	};
	// A card or review screen that opens closes the board first, so it never opens unseen behind it.
	const reviewUi = overrides.review ?? createPhaseReview({}, screens);
	const review = session.reviews.wrap((request, ctx) => session.boards.screen(ctx, () => reviewUi(request, ctx)));
	const decideUi = overrides.decide ?? createDecisionCard(screens);

	registerFlags(pi);

	const tools = {
		state: () => session.state,
		append: (input: EventInput) => session.append(input),
	};
	registerUpdateTool(pi, tools);
	const gate = {
		...tools,
		review: session.watch(review),
		now,
		finalize: (ctx: ExtensionContext) => session.writePlanFile(ctx),
		planTarget: (ctx: ExtensionContext) => session.planTarget(ctx),
	};
	registerAdvanceTool(pi, gate);
	registerDiagramTool(pi, tools);
	registerDecideTool(pi, { ...tools, ui: session.boards.guard(decideUi) });
	registerSliceTool(pi, tools);

	registerEntryRenderer(pi, () => session.state);
	registerCommands(pi, session, {
		gate,
		...(overrides.copy ? { copy: overrides.copy } : {}),
		...(overrides.open ? { open: overrides.open } : {}),
	});
	registerLifecycle(pi, session);
}

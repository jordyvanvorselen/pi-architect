import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ENTRY_TYPE, event } from "../state/events.ts";
import type { ArchitectState } from "../state/types.ts";
import type { Finalized } from "../tools/advance.ts";
import { kickoff } from "./handoff.ts";
import { isDone, type SliceProgress } from "./progress.ts";

/** What `/plan` needs from the extension. */
export interface PlanCommandDeps {
	state(): ArchitectState;
	/** Re-read the plan file. Undefined when it cannot be read. */
	sync(ctx: ExtensionCommandContext): Promise<SliceProgress[] | undefined>;
	/** Write the plan file of the approved architecture. */
	write(ctx: ExtensionCommandContext): Promise<Finalized>;
	/** Switch this session to build mode and send the kickoff. False when the user declined. */
	buildHere(ctx: ExtensionCommandContext, message: string): Promise<boolean>;
	copy(text: string): Promise<void>;
	open(file: string): Promise<void>;
	now(): number;
}

export const PLAN_SUBCOMMANDS = [
	{ value: "build", description: "Build the plan in a new session" },
	{ value: "here", description: "Build the plan in this session, in build mode" },
	{ value: "copy", description: "Copy the plan path" },
	{ value: "open", description: "Open the plan file in your default app" },
	{ value: "path", description: "Show the plan path and progress" },
	{ value: "write", description: "Write the plan file, when it is missing" },
] as const;

type Sub = (typeof PLAN_SUBCOMMANDS)[number]["value"];

const CHOICES: { sub: Sub; label: string }[] = [
	{ sub: "build", label: "Build it in a new session" },
	{ sub: "here", label: "Build it here, in build mode" },
	{ sub: "copy", label: "Copy the path" },
	{ sub: "open", label: "Open the file" },
];

function summary(progress: readonly SliceProgress[] | undefined): string {
	if (!progress) return "the file is missing";
	const done = progress.filter(isDone).length;
	return `${done}/${progress.length} slices done`;
}

/** Write the plan and tell the user where it went, or why it failed. */
async function write(deps: PlanCommandDeps, ctx: ExtensionCommandContext): Promise<boolean> {
	const written = await deps.write(ctx);
	if ("error" in written) {
		ctx.ui.notify(`Writing the plan file failed: ${written.error}`, "error");
		return false;
	}
	ctx.ui.notify(`Plan written to ${written.path}`, "info");
	return true;
}

/** Start a new session that builds the plan. The new session knows the plan, so its widget shows progress. */
async function handoff(deps: PlanCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const plan = deps.state().plan!;
	const entry = event({ type: "plan", path: plan.path, feature: plan.feature, slug: plan.slug, at: deps.now() });
	const message = kickoff(plan.path);
	const parent = ctx.sessionManager.getSessionFile();
	const result = await ctx.newSession({
		...(parent ? { parentSession: parent } : {}),
		setup: async (sessionManager) => {
			sessionManager.appendCustomEntry(ENTRY_TYPE, entry);
		},
		withSession: async (next) => {
			await next.sendUserMessage(message);
		},
	});
	if (result.cancelled) ctx.ui.notify("The new session was cancelled.", "info");
}

/**
 * `/plan [build|here|copy|open|path|write]`. Without an argument it shows the path and progress and offers
 * the actions. Without a plan it explains how to get one, or offers to write an approved one.
 */
export async function planCommand(args: string, ctx: ExtensionCommandContext, deps: PlanCommandDeps): Promise<void> {
	const sub = args.trim().toLowerCase();
	if (sub && !PLAN_SUBCOMMANDS.some((s) => s.value === sub)) {
		ctx.ui.notify(`Unknown /plan action "${sub}". Use ${PLAN_SUBCOMMANDS.map((s) => s.value).join(", ")}.`, "error");
		return;
	}
	const state = deps.state();
	const arch = state.architecture;
	const approved = arch?.approvedAt !== undefined;
	if (!state.plan) {
		if (!approved) {
			ctx.ui.notify("There is no approved plan in this session. Design one with /architect <feature>.", "info");
			return;
		}
		if (
			sub === "write" ||
			(ctx.hasUI && (await ctx.ui.confirm("Write the plan file?", "The plan is approved but has no file yet.")))
		)
			await write(deps, ctx);
		else if (!ctx.hasUI) ctx.ui.notify("The plan is approved but has no file yet. Run /plan write.", "info");
		return;
	}

	const plan = state.plan;
	const progress = await deps.sync(ctx);
	const where = `Plan: ${plan.path} · ${summary(progress)}`;
	let choice: Sub | "" = sub as Sub | "";
	if (!choice) {
		if (!ctx.hasUI) {
			ctx.ui.notify(where, "info");
			return;
		}
		const choices = [
			...(!progress && approved ? [{ sub: "write" as const, label: "Write the file again" }] : []),
			...CHOICES,
		];
		const picked = await ctx.ui.select(
			where,
			choices.map((c) => c.label),
		);
		const found = choices.find((c) => c.label === picked);
		if (!found) return;
		choice = found.sub;
	}

	const missing = !progress && ["build", "here", "open"].includes(choice);
	if (missing) {
		ctx.ui.notify(
			`The plan file ${plan.path} is missing.${approved ? " Run /plan write to write it again." : ""}`,
			"error",
		);
		return;
	}
	switch (choice) {
		case "path":
			ctx.ui.notify(where, "info");
			return;
		case "copy":
			await deps.copy(plan.path);
			ctx.ui.notify(`Copied ${plan.path}`, "info");
			return;
		case "open":
			await deps.open(plan.path);
			return;
		case "write":
			if (progress) ctx.ui.notify(`The plan file is already at ${plan.path}.`, "info");
			else if (!approved)
				ctx.ui.notify("This session cannot write the plan: the design is in another session.", "error");
			else await write(deps, ctx);
			return;
		case "here":
			await deps.buildHere(ctx, kickoff(plan.path));
			return;
		case "build":
			await handoff(deps, ctx);
			return;
	}
}

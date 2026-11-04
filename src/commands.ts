// `/architect` and its subcommands, and the shortcuts.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { parseArchitectArgs } from "./args.ts";
import { confirmDiscard } from "./confirm.ts";
import { planCommand, PLAN_SUBCOMMANDS } from "./plan/command.ts";
import { planFile } from "./plan/write.ts";
import { REVIEW_MESSAGE } from "./reopen.ts";
import type { ArchitectSession } from "./session.ts";
import { slugify } from "./state/queries.ts";
import { isPristine } from "./state/reducer.ts";
import type { AdvanceDeps } from "./tools/advance.ts";
import { BOARD_SHORTCUT } from "./ui/board/index.ts";

export const KICKOFF_MESSAGE = "architect-kickoff";
/** Toggles the mode. Pi does not bind it by default. */
export const SHORTCUT = "ctrl+alt+a";
/** The first words `/architect` reserves. Anything else names a feature. */
export const SUBCOMMAND_NAMES = ["board", "review", "plan", "build", "reset"] as const;
type Subcommand = (typeof SUBCOMMAND_NAMES)[number];

/** The subcommands, in the order the completion and the picker show them. */
const SUBCOMMANDS: readonly { value: Subcommand; description: string; pick: string }[] = [
	{ value: "board", description: "See the whole architecture on one screen", pick: "Open the board" },
	{
		value: "review",
		description: "Review the current phase, e.g. after closing its review",
		pick: "Review this phase",
	},
	{ value: "plan", description: "Show the plan and its progress, with actions", pick: "Plan: path and actions" },
	{ value: "build", description: "Switch to build mode: normal Pi with all tools", pick: "Switch to build mode" },
	{ value: "reset", description: "Discard the architecture in this session", pick: "Discard the architecture" },
];

export interface CommandDeps {
	/** What `/architect review` hands to `architect_advance`. */
	gate: AdvanceDeps;
	/** Copies text to the clipboard, for "Copy the path" in `/architect plan`. */
	copy?: (text: string) => Promise<void>;
	/** Opens a file in the default app, for `/architect plan open`. */
	open?: (file: string) => Promise<void>;
}

/** Register `/architect`, the mode shortcut and the board shortcut. */
export function registerCommands(pi: ExtensionAPI, session: ArchitectSession, deps: CommandDeps): void {
	const { now } = session;

	/** Discard the architecture in this session, after a confirmation. */
	async function reset(ctx: ExtensionCommandContext): Promise<void> {
		const arch = session.state.architecture;
		if (!arch || (isPristine(arch) && !arch.feature)) {
			ctx.ui.notify("There is no architecture to discard.", "info");
			return;
		}
		const name = arch.feature ? ` for "${arch.feature}"` : "";
		const message = `This discards the architecture${name}.`;
		if (ctx.hasUI && !(await confirmDiscard(ctx, "Discard the architecture?", message, "Yes, discard it"))) return;
		session.append({ type: "reset", at: now() });
	}

	/** Architect mode on a named feature. A new name replaces the architecture, after a confirmation. */
	async function begin(feature: string, ctx: ExtensionCommandContext): Promise<void> {
		const arch = session.state.architecture;
		const fresh = !arch || isPristine(arch);
		if (arch && !fresh && arch.feature && arch.feature !== feature) {
			if (!ctx.hasUI) {
				ctx.ui.notify(`Already architecting "${arch.feature || "a feature"}". Run /architect reset first.`, "error");
				return;
			}
			const ok = await confirmDiscard(
				ctx,
				`Architect "${feature}"?`,
				`This discards the architecture${arch.feature ? ` for "${arch.feature}"` : ""}.`,
				`Yes, discard it and architect "${feature}"`,
			);
			if (!ok) return;
		}
		let begun = fresh;
		if (arch && !fresh && !arch.feature)
			session.append({ type: "update", phase: arch.phase, feature: { name: feature, slug: slugify(feature) } });
		else if (!arch || arch.feature !== feature) {
			session.append({ type: "begin", feature, slug: slugify(feature), at: now() });
			begun = true;
		}
		if (session.state.mode !== "architect") session.append(session.modeEvent("architect"));
		if (begun)
			pi.sendMessage(
				{
					customType: KICKOFF_MESSAGE,
					content: `Architect this feature: ${feature}. Start with the Frame phase.`,
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
	}

	/** `/architect plan [open|write|build]`: the plan path and progress, and what to do with the plan. */
	async function plan(args: string, ctx: ExtensionCommandContext): Promise<void> {
		await planCommand(args, ctx, {
			state: () => session.state,
			sync: (c) => session.syncProgress(c),
			write: (c) => session.writePlanFile(c),
			now,
			buildHere: async (c, message) => {
				if (session.state.mode !== "build" && !(await session.setMode("build", c))) return false;
				pi.sendUserMessage(message, c.isIdle() ? undefined : { deliverAs: "followUp" });
				return true;
			},
			copy: deps.copy ?? (async (text) => (await import("@earendil-works/pi-coding-agent")).copyToClipboard(text)),
			open: async (path) => {
				const file = planFile(ctx.cwd, path);
				if (deps.open) return deps.open(file);
				const [cmd, ...args] =
					process.platform === "darwin"
						? ["open", file]
						: process.platform === "win32"
							? ["cmd", "/c", "start", "", file]
							: ["xdg-open", file];
				const result = await pi.exec(cmd!, args);
				if (result.code !== 0) ctx.ui.notify(`Could not open ${path}. Open it yourself: ${file}`, "error");
			},
		});
	}

	async function run(sub: Subcommand, rest: string, ctx: ExtensionCommandContext): Promise<void> {
		if (sub === "plan") return plan(rest, ctx);
		if (rest) {
			ctx.ui.notify(
				`/architect ${sub} takes no arguments. For a feature that starts with "${sub}", put it in quotes: /architect "${sub} ${rest}".`,
				"error",
			);
			return;
		}
		if (sub === "board") await session.showBoard(ctx);
		else if (sub === "review")
			await session.reviews.reopen(deps.gate, ctx, (content) =>
				pi.sendMessage({ customType: REVIEW_MESSAGE, content, display: false }, { triggerTurn: true }),
			);
		else if (sub === "build") await session.setMode("build", ctx);
		else await reset(ctx);
	}

	/**
	 * A first word that starts with a subcommand, like `board6cSplit…` after autocomplete. Ask which one was
	 * meant, with the subcommand first: starting a feature by accident costs more than opening the board.
	 */
	async function suspect(sub: Subcommand, name: string, ctx: ExtensionCommandContext): Promise<void> {
		const feature = `Architect "${name}" as a feature`;
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`Did you mean /architect ${sub}? For a feature that starts with "${sub}", put it in quotes: /architect "${name}".`,
				"error",
			);
			return;
		}
		const meant = `Yes, /architect ${sub}`;
		const picked = await ctx.ui.select(`Did you mean /architect ${sub}?`, [meant, feature]);
		if (picked === meant) await run(sub, "", ctx);
		else if (picked === feature) await begin(name, ctx);
	}

	pi.registerCommand("architect", {
		description:
			"Architect a feature before building it: /architect <feature>, or board, review, plan, build and reset",
		getArgumentCompletions: (prefix) => {
			const text = prefix.trimStart().toLowerCase();
			const planArg = /^plan\s+(\S*)$/.exec(text);
			const items: AutocompleteItem[] = planArg
				? PLAN_SUBCOMMANDS.filter((s) => s.value.startsWith(planArg[1]!)).map((s) => ({
						value: `plan ${s.value}`,
						label: s.value,
						description: s.description,
					}))
				: SUBCOMMANDS.filter((s) => s.value.startsWith(text)).map((s) => ({
						value: s.value,
						label: s.value,
						description: s.description,
					}));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			session.ctx = ctx;
			const parsed = parseArchitectArgs(
				args,
				SUBCOMMANDS.map((s) => s.value),
			);
			if (parsed.kind === "subcommand") return run(parsed.sub, parsed.rest, ctx);
			if (parsed.kind === "feature") return begin(parsed.name, ctx);
			if (parsed.kind === "suspect") return suspect(parsed.sub, parsed.name, ctx);
			const { state } = session;
			if (state.mode !== "architect" || !ctx.hasUI) {
				await session.setMode("architect", ctx);
				return;
			}
			// Already in architect mode: offer what there is to do.
			const feature = state.architecture?.feature;
			const offered = SUBCOMMANDS.filter((s) => s.value !== "review" || session.reviews.canReview(state));
			const picked = await ctx.ui.select(
				`Architect mode${feature ? `: ${feature}` : ""}`,
				offered.map((s) => s.pick),
			);
			const choice = SUBCOMMANDS.find((s) => s.pick === picked);
			if (choice) await run(choice.value, "", ctx);
		},
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Switch between architect and build mode",
		handler: async (ctx) => {
			await session.toggle(ctx);
		},
	});

	pi.registerShortcut(BOARD_SHORTCUT, {
		description: "Open the architecture board",
		handler: async (ctx) => {
			await session.showBoard(ctx);
		},
	});
}

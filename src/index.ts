import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type AutocompleteItem, type TUI } from "@earendil-works/pi-tui";
import { parseArchitectArgs } from "./args.ts";
import { confirmDiscard } from "./confirm.ts";
import { planCommand, PLAN_SUBCOMMANDS } from "./plan/command.ts";
import { buildSection } from "./plan/handoff.ts";
import { buildOrder } from "./plan/order.ts";
import { parsePlanProgress, type SliceProgress } from "./plan/progress.ts";
import { renderPlan } from "./plan/render.ts";
import { DEFAULT_PLAN_DIR, displayPath, nextPlanPath, planFile, readPlan, writePlan } from "./plan/write.ts";
import {
	architectSection,
	drawingRulesInContext,
	MODE_MESSAGE,
	modeNotice,
	modeToldToModel,
	SECTION,
} from "./prompt.ts";
import { allowedInArchitect, blockReason } from "./readonly/index.ts";
import { REVIEW_MESSAGE, Reviews } from "./reopen.ts";
import type { DecisionUi } from "./decision.ts";
import type { ReviewUi } from "./review.ts";
import { ENTRY_TYPE, event, type ArchitectEvent, type EventInput } from "./state/events.ts";
import { slugify } from "./state/queries.ts";
import { INITIAL_STATE, isApproved, isPristine, rebuild, reduce } from "./state/reducer.ts";
import type { ArchitectState, Mode } from "./state/types.ts";
import { registerAdvanceTool, type Finalized } from "./tools/advance.ts";
import { phaseTools } from "./tools/common.ts";
import { registerDecideTool } from "./tools/decide.ts";
import { registerDiagramTool } from "./tools/diagram.ts";
import { registerSliceTool } from "./tools/slice.ts";
import { registerUpdateTool } from "./tools/update.ts";
import { BOARD_HINT, BOARD_SHORTCUT, BoardSession, openBoard } from "./ui/board/index.ts";
import { createDecisionCard } from "./ui/decision/index.ts";
import { choiceEntry, SpanView, verdictEntry } from "./ui/entries.ts";
import type { Paint } from "./ui/paint.ts";
import { createPhaseReview } from "./ui/review/index.ts";
import { STATUS_KEY, modeStatus } from "./ui/status.ts";
import { renderBuildProgress, type BuildView } from "./ui/progress.ts";
import { LineComponent, renderStepper } from "./ui/stepper.ts";

export { ENTRY_TYPE } from "./state/events.ts";
export const WIDGET_KEY = "architect";
export const KICKOFF_MESSAGE = "architect-kickoff";
/** Toggles the mode. Pi does not bind it by default. */
export const SHORTCUT = "ctrl+alt+a";
export const FLAG = "architect";
/** `--architect-plan-dir <dir>`: where plan files go, relative to the cwd. */
export const PLAN_DIR_FLAG = "architect-plan-dir";
/** The first words `/architect` reserves. Anything else names a feature. */
export const SUBCOMMAND_NAMES = ["board", "review", "plan", "build", "reset"] as const;
type Subcommand = (typeof SUBCOMMAND_NAMES)[number];

/** The column `pi --help` starts flag descriptions at: it pads `  --name <value>` to this width. */
export const HELP_COLUMN = 30;

/**
 * A flag description that `pi --help` keeps apart from the flag. Pi pads the flag to 30 columns without a
 * space after it, so a flag of 28 columns or more would run into its description.
 */
export function flagHelp(name: string, type: "boolean" | "string", text: string): string {
	const flag = `  --${name}${type === "string" ? " <value>" : ""}`;
	return flag.length >= HELP_COLUMN - 1 ? ` ${text}` : text;
}

/** Tools only architect mode needs. Every tool named `architect_*` counts, so later tools join automatically. */
export const isArchitectTool = (name: string) => name.startsWith("architect_");

/** What build mode brings back when nothing recorded what architect mode turned off. */
const WRITE_TOOLS = ["edit", "write"];

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
	const grace = { now, ...(overrides.inputGrace !== undefined ? { graceMs: overrides.inputGrace } : {}) };
	// The review screens and decision cards open the board with `b`: Pi runs extension shortcuts only from
	// the main editor, so ctrl+alt+b does not reach them. Read-only there: the answer on the screen is the
	// way to give feedback, and the agent is waiting for it.
	const screens = {
		...grace,
		board: (ctx: ExtensionContext) => {
			showBoard(ctx, { readOnly: true }).catch((error: unknown) =>
				ctx.ui.notify(`Could not open the board: ${error instanceof Error ? error.message : String(error)}`, "error"),
			);
		},
	};
	// Remembers a review closed without a verdict, so `/architect review` can open it again.
	const reviews = new Reviews();
	// A card or review screen that opens closes the board first, so it never opens unseen behind it.
	const reviewUi = overrides.review ?? createPhaseReview({}, screens);
	const review = reviews.wrap((request, ctx) => boards.screen(ctx, () => reviewUi(request, ctx)));
	const decideUi = overrides.decide ?? createDecisionCard(screens);
	let state: ArchitectState = INITIAL_STATE;
	let ctxRef: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let widget: "stepper" | "plan" | undefined;
	/** Slices of the plan file as last read. The file is the source of truth, so this is only a cache. */
	let progress: SliceProgress[] | undefined;

	/** The board, so it redraws when the architecture changes and opens once. */
	const boards = new BoardSession();

	/**
	 * Make the active tools fit the mode and the phase. Architect mode turns off every tool the read-only
	 * allowlist does not allow, so their schemas are not sent, and the architect tools of the current phase on
	 * (see `phaseTools`). Build mode turns the architect tools off and exactly the tools architect mode turned
	 * off back on. A reload keeps the current tools and turns on every extension tool, and a resume or /tree
	 * restores the tool set from the transcript, so this works from the state alone and never from what it
	 * turned off in memory.
	 */
	function applyTools(): void {
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
			if (late.length) append({ type: "tools", turnedOff: late });
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
	const toolKey = (s: ArchitectState) =>
		s.mode === "architect" ? `architect:${phaseTools(s.architecture).join(",")}` : "build";

	/** The event that switches mode. Entering architect mode remembers which tools it turns off. */
	function modeEvent(mode: Mode): EventInput {
		if (mode === "build") return { type: "mode", mode, at: now() };
		const turnedOff = pi.getActiveTools().filter((n) => !allowedInArchitect(n));
		return { type: "mode", mode, at: now(), turnedOff };
	}

	function refresh(): void {
		const ctx = ctxRef;
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme as Paint;
		boards.update();
		ctx.ui.setStatus(STATUS_KEY, modeStatus(state, theme));
		// The board shortcut only works in Pi's terminal UI.
		const hint = ctx.mode === "tui" ? BOARD_HINT : undefined;
		const arch = state.architecture;
		const wanted = state.mode === "architect" && arch ? "stepper" : state.plan || isApproved(arch) ? "plan" : undefined;
		const draw = (width: number, paint: Paint) => {
			const a = state.architecture;
			if (widget === "stepper") return a ? renderStepper(a, width, paint, hint) : undefined;
			const view = buildView();
			return view ? renderBuildProgress(view, width, paint, hint) : undefined;
		};
		if (!wanted) {
			if (widget) ctx.ui.setWidget(WIDGET_KEY, undefined);
			widget = undefined;
			tui = undefined;
			return;
		}
		if (ctx.mode !== "tui") {
			// RPC clients get plain lines; component factories are ignored there.
			widget = wanted;
			const line = draw(100, theme);
			ctx.ui.setWidget(WIDGET_KEY, line === undefined ? undefined : [line]);
			return;
		}
		if (widget === wanted && tui) {
			tui.requestRender();
			return;
		}
		widget = wanted;
		ctx.ui.setWidget(WIDGET_KEY, (t, th) => {
			tui = t;
			return new LineComponent((width) => draw(width, th as Paint));
		});
	}

	function append(input: EventInput): void {
		const e: ArchitectEvent = event(input);
		pi.appendEntry(ENTRY_TYPE, e);
		const before = toolKey(state);
		state = reduce(state, e);
		// A new or discarded architecture: the summary of a review closed before it is not about this one.
		if (e.type === "begin" || e.type === "reset") reviews.clear();
		// A mode switch or a phase approval changes the tools, also in the middle of a run: Pi declares
		// the new set before the next request.
		if (toolKey(state) !== before) applyTools();
		refresh();
	}

	function load(ctx: ExtensionContext): void {
		ctxRef = ctx;
		state = rebuild(ctx.sessionManager.getBranch());
		progress = undefined;
		reviews.clear();
		applyTools();
		// Pi quit or the branch changed while a review was open: nobody waits for that review any more, so
		// the phase goes back to working instead of staying in review for good.
		const arch = state.architecture;
		if (arch?.status === "review" && reviewing === 0 && ctx.isIdle())
			append({ type: "withdraw", phase: arch.phase, at: now() });
		refresh();
	}

	/** The build widget's content: the plan file's slices, or the architecture's while the file is missing. */
	function buildView(): BuildView | undefined {
		const arch = state.architecture;
		const plan = state.plan;
		const name = plan?.slug || arch?.slug || "plan";
		if (plan && progress) return { name, slices: progress };
		if (!plan && !isApproved(arch)) return undefined;
		const slices = buildOrder(arch?.slices ?? []).map((o) => ({
			number: o.number,
			title: o.slice.title,
			total: o.slice.steps.length + 1,
			checked: 0,
		}));
		return {
			name,
			slices,
			problem: plan ? "plan file not found · /architect plan" : "plan not written · /architect plan write",
		};
	}

	/** Re-read the plan file and redraw when its boxes changed. */
	async function syncProgress(ctx: ExtensionContext): Promise<SliceProgress[] | undefined> {
		const plan = state.plan;
		if (!plan) return undefined;
		const text = await readPlan(planFile(ctx.cwd, plan.path));
		const next = text === undefined ? undefined : parsePlanProgress(text);
		if (JSON.stringify(next) !== JSON.stringify(progress)) {
			progress = next;
			refresh();
		}
		return progress;
	}

	function planDir(): string {
		const flag = pi.getFlag(PLAN_DIR_FLAG);
		return overrides.planDir ?? (typeof flag === "string" && flag.trim() ? flag.trim() : DEFAULT_PLAN_DIR);
	}

	/** Where approving the Blueprint writes the plan file, with a taken name already numbered as the writer would. */
	function planTarget(ctx: ExtensionContext): string | undefined {
		const arch = state.architecture;
		if (!arch) return undefined;
		const file = nextPlanPath(planFile(ctx.cwd, planDir()), arch.slug || slugify(arch.feature));
		return file && displayPath(ctx.cwd, file);
	}

	/** Write the approved plan to a new file and record where. Never overwrites a file. */
	async function writePlanFile(ctx: ExtensionContext): Promise<Finalized> {
		const arch = state.architecture;
		if (!arch || !isApproved(arch)) return { error: "the plan is not approved" };
		try {
			const content = renderPlan(arch, { session: ctx.sessionManager.getSessionId() });
			const slug = arch.slug || slugify(arch.feature);
			const file = await writePlan(planFile(ctx.cwd, planDir()), slug, content);
			const path = displayPath(ctx.cwd, file);
			progress = parsePlanProgress(content);
			append({ type: "plan", path, feature: arch.feature, slug, at: now() });
			return { path };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Switch mode after a confirmation where work would be left unapproved. Returns false when the user declined. */
	async function setMode(mode: Mode, ctx: ExtensionContext): Promise<boolean> {
		ctxRef = ctx;
		if (state.mode === mode) {
			if (ctx.hasUI) ctx.ui.notify(`Already in ${mode} mode.`, "info");
			return true;
		}
		const arch = state.architecture;
		if (mode === "build" && ctx.hasUI && !isApproved(arch) && !isPristine(arch)) {
			const ok = await ctx.ui.confirm(
				"Switch to build mode?",
				"The plan is not approved yet. Switch to build anyway? Switching back to architect resumes where you left off.",
			);
			if (!ok) return false;
		}
		append(modeEvent(mode));
		return true;
	}

	const toggle = (ctx: ExtensionContext) => setMode(state.mode === "architect" ? "build" : "architect", ctx);

	/**
	 * The whole architecture on one overlay. Comments the user writes there go to the agent on close.
	 * `readOnly` turns comments off, for a board over a review screen or decision card.
	 */
	async function showBoard(ctx: ExtensionContext, { readOnly = false } = {}): Promise<void> {
		ctxRef = ctx;
		await boards.show(readOnly, async (hooks) => {
			await syncProgress(ctx);
			const plan = state.plan;
			const planText = plan ? await readPlan(planFile(ctx.cwd, plan.path)) : undefined;
			const target = planTarget(ctx);
			const session = ctx.sessionManager.getSessionId();
			return openBoard(ctx, {
				data: () => ({
					mode: state.mode,
					...(state.architecture ? { arch: state.architecture } : {}),
					...(state.plan ? { plan: state.plan } : {}),
					...(planText !== undefined && state.plan === plan ? { planText } : {}),
					...(target ? { planTarget: target } : {}),
					...(progress ? { progress } : {}),
					session,
				}),
				send: (text, options) => pi.sendUserMessage(text, options),
				readOnly,
				...hooks,
			});
		});
	}

	pi.registerFlag(FLAG, {
		description: flagHelp(FLAG, "boolean", "Start in architect mode: design a feature before building it"),
		type: "boolean",
	});
	pi.registerFlag(PLAN_DIR_FLAG, {
		description: flagHelp(
			PLAN_DIR_FLAG,
			"string",
			`Where approved plans are written, relative to the working directory (default ${DEFAULT_PLAN_DIR})`,
		),
		type: "string",
	});

	const tools = { state: () => state, append };
	registerUpdateTool(pi, tools);
	/** Reviews open right now, so loading a branch does not withdraw one that a tool waits for. */
	let reviewing = 0;
	const watched: ReviewUi = async (request, ctx) => {
		reviewing++;
		try {
			return await review(request, ctx);
		} finally {
			reviewing--;
		}
	};
	const gate = { ...tools, review: watched, now, finalize: writePlanFile, planTarget };
	registerAdvanceTool(pi, gate);
	registerDiagramTool(pi, tools);
	registerDecideTool(pi, { ...tools, ui: boards.guard(decideUi) });
	registerSliceTool(pi, tools);

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
			const decision = state.architecture?.decisions.find((d) => d.id === e.id);
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

	/** Discard the architecture in this session, after a confirmation. */
	async function reset(ctx: ExtensionCommandContext): Promise<void> {
		const arch = state.architecture;
		if (!arch || (isPristine(arch) && !arch.feature)) {
			ctx.ui.notify("There is no architecture to discard.", "info");
			return;
		}
		const name = arch.feature ? ` for "${arch.feature}"` : "";
		const message = `This discards the architecture${name}.`;
		if (ctx.hasUI && !(await confirmDiscard(ctx, "Discard the architecture?", message, "Yes, discard it"))) return;
		append({ type: "reset", at: now() });
	}

	/** Architect mode on a named feature. A new name replaces the architecture, after a confirmation. */
	async function begin(feature: string, ctx: ExtensionCommandContext): Promise<void> {
		const arch = state.architecture;
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
			append({ type: "update", phase: arch.phase, feature: { name: feature, slug: slugify(feature) } });
		else if (!arch || arch.feature !== feature) {
			append({ type: "begin", feature, slug: slugify(feature), at: now() });
			begun = true;
		}
		if (state.mode !== "architect") append(modeEvent("architect"));
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
			state: () => state,
			sync: syncProgress,
			write: writePlanFile,
			now,
			buildHere: async (c, message) => {
				if (state.mode !== "build" && !(await setMode("build", c))) return false;
				pi.sendUserMessage(message, c.isIdle() ? undefined : { deliverAs: "followUp" });
				return true;
			},
			copy: overrides.copy ?? (async (text) => (await import("@earendil-works/pi-coding-agent")).copyToClipboard(text)),
			open: async (path) => {
				const file = planFile(ctx.cwd, path);
				if (overrides.open) return overrides.open(file);
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

	async function run(sub: Subcommand, rest: string, ctx: ExtensionCommandContext): Promise<void> {
		if (sub === "plan") return plan(rest, ctx);
		if (rest) {
			ctx.ui.notify(
				`/architect ${sub} takes no arguments. For a feature that starts with "${sub}", put it in quotes: /architect "${sub} ${rest}".`,
				"error",
			);
			return;
		}
		if (sub === "board") await showBoard(ctx);
		else if (sub === "review")
			await reviews.reopen(gate, ctx, (content) =>
				pi.sendMessage({ customType: REVIEW_MESSAGE, content, display: false }, { triggerTurn: true }),
			);
		else if (sub === "build") await setMode("build", ctx);
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
			ctxRef = ctx;
			const parsed = parseArchitectArgs(
				args,
				SUBCOMMANDS.map((s) => s.value),
			);
			if (parsed.kind === "subcommand") return run(parsed.sub, parsed.rest, ctx);
			if (parsed.kind === "feature") return begin(parsed.name, ctx);
			if (parsed.kind === "suspect") return suspect(parsed.sub, parsed.name, ctx);
			if (state.mode !== "architect" || !ctx.hasUI) {
				await setMode("architect", ctx);
				return;
			}
			// Already in architect mode: offer what there is to do.
			const feature = state.architecture?.feature;
			const offered = SUBCOMMANDS.filter((s) => s.value !== "review" || reviews.canReview(state));
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
			await toggle(ctx);
		},
	});

	pi.registerShortcut(BOARD_SHORTCUT, {
		description: "Open the architecture board",
		handler: async (ctx) => {
			await showBoard(ctx);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		load(ctx);
		await syncProgress(ctx);
		if (event.reason === "startup" && pi.getFlag(FLAG) === true && state.mode !== "architect")
			await setMode("architect", ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		load(ctx);
		await syncProgress(ctx);
	});

	// Progress lives in the plan file's boxes. Re-read it after a tool that may have ticked one, and after
	// each run as a catch-all for other ways to edit it.
	pi.on("tool_result", async (event, ctx) => {
		const plan = state.plan;
		if (!plan || event.isError) return;
		const path = (event.input as { path?: unknown } | undefined)?.path;
		const touches =
			event.toolName === "bash" ||
			(typeof path === "string" && planFile(ctx.cwd, path.replace(/^@/, "")) === planFile(ctx.cwd, plan.path));
		if (touches) await syncProgress(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await syncProgress(ctx);
	});

	pi.on("session_shutdown", async () => {
		ctxRef = undefined;
		tui = undefined;
		widget = undefined;
		progress = undefined;
	});

	pi.on("tool_call", async (event) => {
		if (state.mode !== "architect") return;
		const reason = blockReason(event.toolName, event.input);
		if (reason) return { block: true, reason };
	});

	// Tools can register after architect mode started, e.g. MCP tools, also in the middle of a run: turn them
	// off before each request.
	pi.on("turn_start", async () => {
		if (state.mode === "architect") applyTools();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		ctxRef = ctx;
		if (state.mode === "architect") applyTools();
		const sections = event.systemPromptOptions.sections;
		const section =
			architectSection(state, {
				drawingRulesInContext:
					state.architecture !== undefined &&
					drawingRulesInContext(ctx.sessionManager.getBranch(), state.architecture.phase),
			}) ?? (state.mode === "build" && state.plan ? buildSection(state.plan, progress) : undefined);
		if (section) sections[SECTION] = section;
		else delete sections[SECTION];
		if (modeToldToModel(ctx.sessionManager.getBranch()) === state.mode) return;
		return {
			message: {
				customType: MODE_MESSAGE,
				content: modeNotice(state.mode, state.architecture),
				display: false,
				details: { mode: state.mode },
			},
		};
	});
}

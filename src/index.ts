import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type AutocompleteItem, type TUI } from "@earendil-works/pi-tui";
import { architectSection, MODE_MESSAGE, modeNotice, modeToldToModel, SECTION } from "./prompt.ts";
import { blockReason, WRITE_TOOLS } from "./readonly/index.ts";
import { selectReview, type ReviewUi } from "./review.ts";
import { ENTRY_TYPE, event, type ArchitectEvent, type EventInput } from "./state/events.ts";
import { slugify } from "./state/queries.ts";
import { INITIAL_STATE, isApproved, isPristine, rebuild, reduce } from "./state/reducer.ts";
import type { ArchitectState, Mode } from "./state/types.ts";
import { advance, AdvanceParams, type AdvanceDetails } from "./tools/advance.ts";
import { registerDiagramTool } from "./tools/diagram.ts";
import { planUpdate, prepareUpdateArgs, UpdateParams, type UpdateDetails } from "./tools/update.ts";
import type { Paint } from "./ui/paint.ts";
import { STATUS_KEY, modeStatus } from "./ui/status.ts";
import { LineComponent, renderPlanProgress, renderStepper } from "./ui/stepper.ts";
import { advanceCall, advanceResult, updateCall, updateResult } from "./ui/tools.ts";

export { ENTRY_TYPE } from "./state/events.ts";
export const WIDGET_KEY = "architect";
export const KICKOFF_MESSAGE = "architect-kickoff";
/** Toggles the mode. Pi does not bind it by default. */
export const SHORTCUT = "ctrl+alt+a";
export const FLAG = "architect";

/** Tools only architect mode needs. Every tool named `architect_*` counts, so later tools join automatically. */
export const isArchitectTool = (name: string) => name.startsWith("architect_");
/** Tools architect mode turns off. */
const OFF_IN_ARCHITECT: readonly string[] = [...WRITE_TOOLS, "powershell"];

/** Test seams. Pi calls the factory with `pi` only. */
export interface ArchitectOverrides {
	/** Replaces the phase review screen. */
	review?: ReviewUi;
	now?: () => number;
}

const textOf = (result: { content: { type: string; text?: string }[] }) =>
	result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");

export default function architectExtension(pi: ExtensionAPI, overrides: ArchitectOverrides = {}): void {
	const now = overrides.now ?? Date.now;
	const review = overrides.review ?? selectReview;
	let state: ArchitectState = INITIAL_STATE;
	let ctxRef: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let widget: "stepper" | "plan" | undefined;
	/** Tools architect mode turned off, to turn back on in build mode. In memory: Pi starts with its defaults again. */
	const turnedOff = new Set<string>();

	const has = (name: string) => pi.getAllTools().some((t) => t.name === name);

	function applyTools(): void {
		const active = pi.getActiveTools();
		let next: string[];
		if (state.mode === "architect") {
			for (const name of active) if (OFF_IN_ARCHITECT.includes(name)) turnedOff.add(name);
			const architect = pi
				.getAllTools()
				.map((t) => t.name)
				.filter(isArchitectTool);
			next = [...new Set([...active.filter((n) => !OFF_IN_ARCHITECT.includes(n)), ...architect])];
		} else {
			next = [...new Set([...active.filter((n) => !isArchitectTool(n)), ...turnedOff])];
			turnedOff.clear();
		}
		if (next.length !== active.length || next.some((n, i) => n !== active[i])) pi.setActiveTools(next);
	}

	function refresh(): void {
		const ctx = ctxRef;
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme as Paint;
		ctx.ui.setStatus(STATUS_KEY, modeStatus(state, theme));
		const arch = state.architecture;
		const wanted = state.mode === "architect" && arch ? "stepper" : arch && isApproved(arch) ? "plan" : undefined;
		const draw = (width: number, paint: Paint) => {
			const a = state.architecture;
			if (!a) return undefined;
			return widget === "stepper" ? renderStepper(a, width, paint) : renderPlanProgress(a, width, paint);
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
		const before = state.mode;
		state = reduce(state, e);
		if (state.mode !== before) applyTools();
		refresh();
	}

	function load(ctx: ExtensionContext): void {
		ctxRef = ctx;
		state = rebuild(ctx.sessionManager.getBranch());
		applyTools();
		refresh();
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
		append({ type: "mode", mode, at: now() });
		return true;
	}

	const toggle = (ctx: ExtensionContext) => setMode(state.mode === "architect" ? "build" : "architect", ctx);

	pi.registerFlag(FLAG, {
		description: "Start in architect mode: design a feature before building it",
		type: "boolean",
	});

	pi.registerTool({
		name: "architect_update",
		label: "Architect update",
		description:
			"Record content of the current architect phase and return at once: feature name, brief (Frame), modules and findings " +
			"(Explore and later), risks (any phase). Lists in brief replace the old list, modules update by path, " +
			"a risk with an id changes that risk. remove takes finding or risk ids and module paths.",
		promptSnippet: "Record the brief, modules, findings and risks of the current architect phase",
		promptGuidelines: [
			"Use architect_update to record phase content as you go. The user sees it on screen, so do not repeat it in chat.",
		],
		parameters: UpdateParams,
		defaultActive: false,
		prepareArguments: prepareUpdateArgs,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const arch = state.architecture;
			if (state.mode !== "architect" || !arch)
				throw new Error("architect_update only works in architect mode. The user switches with /mode architect.");
			const plan = planUpdate(arch, params, has);
			append(plan.event);
			return { content: [{ type: "text", text: plan.text }], details: plan.details };
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(updateCall(args, theme as Paint));
			return text;
		},
		renderResult(result, { expanded }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				updateResult(
					result.details as UpdateDetails | undefined,
					textOf(result),
					expanded,
					context.isError,
					theme as Paint,
				),
			);
			return text;
		},
	});

	pi.registerTool({
		name: "architect_advance",
		label: "Architect advance",
		description:
			"Ask the user to review the current architect phase, and wait. Approval moves to the next phase; " +
			"otherwise you get the user's comment. When the phase is incomplete it fails at once with what is missing.",
		promptSnippet: "Ask the user to review and approve the current architect phase",
		promptGuidelines: [
			"Call architect_advance when an architect phase is complete. The user approves every phase; never skip one.",
		],
		parameters: AdvanceParams,
		defaultActive: false,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			ctxRef = ctx;
			return advance({ state: () => state, append, review, now, has }, params, signal, ctx);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(advanceCall(args, theme as Paint));
			return text;
		},
		renderResult(result, { isPartial }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				advanceResult(result.details as AdvanceDetails | undefined, textOf(result), isPartial, theme as Paint),
			);
			return text;
		},
	});

	registerDiagramTool(pi, { state: () => state, append, has });

	pi.registerEntryRenderer<ArchitectEvent>(ENTRY_TYPE, (entry, _options, theme) => {
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
		return undefined;
	});

	const modeItems: AutocompleteItem[] = [
		{ value: "architect", label: "architect", description: "Design a feature first: read-only, phase by phase" },
		{ value: "build", label: "build", description: "Normal Pi with all tools" },
	];

	pi.registerCommand("mode", {
		description: "Switch between architect mode (design first, read-only) and build mode",
		getArgumentCompletions: (prefix) => {
			const items = modeItems.filter((i) => i.value.startsWith(prefix.trim()));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const wanted = args.trim().toLowerCase();
			if (wanted === "architect" || wanted === "build") {
				await setMode(wanted, ctx);
				return;
			}
			if (wanted) {
				ctx.ui.notify(`Unknown mode "${wanted}". Use /mode architect or /mode build.`, "error");
				return;
			}
			if (!ctx.hasUI) return;
			const labels = modeItems.map((i) => `${i.value === state.mode ? "●" : "○"} ${i.value}: ${i.description}`);
			const choice = await ctx.ui.select(`Mode (now ${state.mode})`, labels);
			const picked = modeItems.find((_, i) => labels[i] === choice);
			if (picked) await setMode(picked.value as Mode, ctx);
		},
	});

	const architectItems: AutocompleteItem[] = [
		{ value: "reset", label: "reset", description: "Discard the architecture in this session" },
	];

	pi.registerCommand("architect", {
		description: "Architect a feature: /architect <feature> starts, /architect reset discards",
		getArgumentCompletions: (prefix) => {
			const items = architectItems.filter((i) => i.value.startsWith(prefix.trim()));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const feature = args.trim();
			if (feature === "reset") {
				const arch = state.architecture;
				if (!arch || (isPristine(arch) && !arch.feature)) {
					ctx.ui.notify("There is no architecture to discard.", "info");
					return;
				}
				const name = arch.feature ? ` for "${arch.feature}"` : "";
				if (ctx.hasUI && !(await ctx.ui.confirm("Discard the architecture?", `This discards the architecture${name}.`)))
					return;
				append({ type: "reset", at: now() });
				return;
			}
			if (!feature) {
				await setMode("architect", ctx);
				return;
			}
			const arch = state.architecture;
			const fresh = !arch || isPristine(arch);
			if (arch && !fresh && arch.feature && arch.feature !== feature) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Already architecting "${arch.feature || "a feature"}". Run /architect reset first.`, "error");
					return;
				}
				const ok = await ctx.ui.confirm(
					`Architect "${feature}"?`,
					`This discards the architecture${arch.feature ? ` for "${arch.feature}"` : ""}.`,
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
			if (state.mode !== "architect") append({ type: "mode", mode: "architect", at: now() });
			if (begun)
				pi.sendMessage(
					{
						customType: KICKOFF_MESSAGE,
						content: `Architect this feature: ${feature}. Start with the Frame phase.`,
						display: false,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
		},
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Switch between architect and build mode",
		handler: async (ctx) => {
			await toggle(ctx);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		load(ctx);
		if (event.reason === "startup" && pi.getFlag(FLAG) === true && state.mode !== "architect")
			await setMode("architect", ctx);
	});

	pi.on("session_tree", async (_event, ctx) => load(ctx));

	pi.on("session_shutdown", async () => {
		ctxRef = undefined;
		tui = undefined;
		widget = undefined;
	});

	pi.on("tool_call", async (event) => {
		if (state.mode !== "architect") return;
		const reason = blockReason(event.toolName, event.input);
		if (reason) return { block: true, reason };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		ctxRef = ctx;
		const sections = event.systemPromptOptions.sections;
		const section = architectSection(state, has);
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

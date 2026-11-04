// The extension's state for one Pi session: the architecture, the mode, the plan file's progress, and what
// changes them.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PLAN_DIR_FLAG } from "./flags.ts";
import { parsePlanProgress, type SliceProgress } from "./plan/progress.ts";
import { renderPlan } from "./plan/render.ts";
import { DEFAULT_PLAN_DIR, displayPath, nextPlanPath, planFile, readPlan, writePlan } from "./plan/write.ts";
import { Reviews } from "./reopen.ts";
import type { ReviewUi } from "./review.ts";
import { ENTRY_TYPE, event, type ArchitectEvent, type EventInput } from "./state/events.ts";
import { slugify } from "./state/queries.ts";
import { INITIAL_STATE, isApproved, isPristine, rebuild, reduce } from "./state/reducer.ts";
import type { ArchitectState, Mode } from "./state/types.ts";
import { applyTools, toolKey, turnedOffByArchitect } from "./tools-activation.ts";
import type { Finalized } from "./tools/advance.ts";
import { BoardSession, openBoard } from "./ui/board/index.ts";
import { Widgets } from "./widgets.ts";

export interface SessionOptions {
	/** The clock, for event times. */
	now: () => number;
	/** Where plan files go, relative to the cwd or absolute. Beats the flag. */
	planDir?: string;
}

export class ArchitectSession {
	state: ArchitectState = INITIAL_STATE;
	/** The context of the last event or command, for redraws outside of one. */
	ctx: ExtensionContext | undefined;
	/** Slices of the plan file as last read. The file is the source of truth, so this is only a cache. */
	progress: SliceProgress[] | undefined;
	/** Remembers a review closed without a verdict, so `/architect review` can open it again. */
	readonly reviews = new Reviews();
	/** The board, so it redraws when the architecture changes and opens once. */
	readonly boards = new BoardSession();
	readonly widgets = new Widgets(this);
	readonly now: () => number;
	private readonly pi: ExtensionAPI;
	private readonly options: SessionOptions;
	/** Reviews open right now, so loading a branch does not withdraw one that a tool waits for. */
	private reviewing = 0;

	constructor(pi: ExtensionAPI, options: SessionOptions) {
		this.pi = pi;
		this.options = options;
		this.now = options.now;
	}

	/** Record an event, apply it and redraw. */
	append(input: EventInput): void {
		const e: ArchitectEvent = event(input);
		this.pi.appendEntry(ENTRY_TYPE, e);
		const before = toolKey(this.state);
		this.state = reduce(this.state, e);
		// A new or discarded architecture: the summary of a review closed before it is not about this one.
		if (e.type === "begin" || e.type === "reset") this.reviews.clear();
		// A mode switch or a phase approval changes the tools, also in the middle of a run: Pi declares
		// the new set before the next request.
		if (toolKey(this.state) !== before) this.applyTools();
		this.refresh();
	}

	/** Make the active tools fit the mode and the phase. */
	applyTools(): void {
		applyTools(this.pi, this.state, (turnedOff) => this.append({ type: "tools", turnedOff }));
	}

	/** Redraw the status, the widget and the board. */
	refresh(): void {
		if (!this.ctx?.hasUI) return;
		this.boards.update();
		this.widgets.refresh(this.ctx);
	}

	/** Rebuild the state from the current branch, after a start, a resume or /tree. */
	load(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.state = rebuild(ctx.sessionManager.getBranch());
		this.progress = undefined;
		this.reviews.clear();
		this.applyTools();
		// Pi quit or the branch changed while a review was open: nobody waits for that review any more, so
		// the phase goes back to working instead of staying in review for good.
		const arch = this.state.architecture;
		if (arch?.status === "review" && this.reviewing === 0 && ctx.isIdle())
			this.append({ type: "withdraw", phase: arch.phase, at: this.now() });
		this.refresh();
	}

	/** Forget the context and the caches when the session shuts down. */
	shutdown(): void {
		this.ctx = undefined;
		this.widgets.reset();
		this.progress = undefined;
	}

	/** `review`, counted while it is open. */
	watch(review: ReviewUi): ReviewUi {
		return async (request, ctx) => {
			this.reviewing++;
			try {
				return await review(request, ctx);
			} finally {
				this.reviewing--;
			}
		};
	}

	/** Re-read the plan file and redraw when its boxes changed. */
	async syncProgress(ctx: ExtensionContext): Promise<SliceProgress[] | undefined> {
		const plan = this.state.plan;
		if (!plan) return undefined;
		const text = await readPlan(planFile(ctx.cwd, plan.path));
		const next = text === undefined ? undefined : parsePlanProgress(text);
		if (JSON.stringify(next) !== JSON.stringify(this.progress)) {
			this.progress = next;
			this.refresh();
		}
		return this.progress;
	}

	private planDir(): string {
		const flag = this.pi.getFlag(PLAN_DIR_FLAG);
		return this.options.planDir ?? (typeof flag === "string" && flag.trim() ? flag.trim() : DEFAULT_PLAN_DIR);
	}

	/** Where approving the Blueprint writes the plan file, with a taken name already numbered as the writer would. */
	planTarget(ctx: ExtensionContext): string | undefined {
		const arch = this.state.architecture;
		if (!arch) return undefined;
		const file = nextPlanPath(planFile(ctx.cwd, this.planDir()), arch.slug || slugify(arch.feature));
		return file && displayPath(ctx.cwd, file);
	}

	/** Write the approved plan to a new file and record where. Never overwrites a file. */
	async writePlanFile(ctx: ExtensionContext): Promise<Finalized> {
		const arch = this.state.architecture;
		if (!arch || !isApproved(arch)) return { error: "the plan is not approved" };
		try {
			const content = renderPlan(arch, { session: ctx.sessionManager.getSessionId() });
			const slug = arch.slug || slugify(arch.feature);
			const file = await writePlan(planFile(ctx.cwd, this.planDir()), slug, content);
			const path = displayPath(ctx.cwd, file);
			this.progress = parsePlanProgress(content);
			this.append({ type: "plan", path, feature: arch.feature, slug, at: this.now() });
			return { path };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** The event that switches mode. Entering architect mode remembers which tools it turns off. */
	modeEvent(mode: Mode): EventInput {
		if (mode === "build") return { type: "mode", mode, at: this.now() };
		return { type: "mode", mode, at: this.now(), turnedOff: turnedOffByArchitect(this.pi) };
	}

	/** Switch mode after a confirmation where work would be left unapproved. Returns false when the user declined. */
	async setMode(mode: Mode, ctx: ExtensionContext): Promise<boolean> {
		this.ctx = ctx;
		if (this.state.mode === mode) {
			if (ctx.hasUI) ctx.ui.notify(`Already in ${mode} mode.`, "info");
			return true;
		}
		const arch = this.state.architecture;
		if (mode === "build" && ctx.hasUI && !isApproved(arch) && !isPristine(arch)) {
			const ok = await ctx.ui.confirm(
				"Switch to build mode?",
				"The plan is not approved yet. Switch to build anyway? Switching back to architect resumes where you left off.",
			);
			if (!ok) return false;
		}
		this.append(this.modeEvent(mode));
		return true;
	}

	toggle(ctx: ExtensionContext): Promise<boolean> {
		return this.setMode(this.state.mode === "architect" ? "build" : "architect", ctx);
	}

	/**
	 * The whole architecture on one overlay. Comments the user writes there go to the agent on close.
	 * `readOnly` turns comments off, for a board over a review screen or decision card.
	 */
	async showBoard(ctx: ExtensionContext, { readOnly = false } = {}): Promise<void> {
		this.ctx = ctx;
		await this.boards.show(readOnly, async (hooks) => {
			await this.syncProgress(ctx);
			const plan = this.state.plan;
			const planText = plan ? await readPlan(planFile(ctx.cwd, plan.path)) : undefined;
			const target = this.planTarget(ctx);
			const session = ctx.sessionManager.getSessionId();
			return openBoard(ctx, {
				data: () => {
					const { state, progress } = this;
					return {
						mode: state.mode,
						...(state.architecture ? { arch: state.architecture } : {}),
						...(state.plan ? { plan: state.plan } : {}),
						...(planText !== undefined && state.plan === plan ? { planText } : {}),
						...(target ? { planTarget: target } : {}),
						...(progress ? { progress } : {}),
						session,
					};
				},
				send: (text, options) => this.pi.sendUserMessage(text, options),
				readOnly,
				...hooks,
			});
		});
	}
}

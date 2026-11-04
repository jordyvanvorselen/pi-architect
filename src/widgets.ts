// The footer status and the line above the editor: the stepper in architect mode, slice progress in build mode.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { buildOrder } from "./plan/order.ts";
import type { SliceProgress } from "./plan/progress.ts";
import { isApproved } from "./state/reducer.ts";
import type { ArchitectState } from "./state/types.ts";
import { BOARD_HINT } from "./ui/board/index.ts";
import type { Paint } from "./ui/paint.ts";
import { renderBuildProgress, type BuildView } from "./ui/progress.ts";
import { STATUS_KEY, modeStatus } from "./ui/status.ts";
import { LineComponent, renderStepper } from "./ui/stepper.ts";

export const WIDGET_KEY = "architect";

/** What the widgets show, read at draw time so a drawn line is always current. */
export interface WidgetSource {
	readonly state: ArchitectState;
	/** Slices of the plan file as last read. */
	readonly progress: SliceProgress[] | undefined;
}

/** The build widget's content: the plan file's slices, or the architecture's while the file is missing. */
export function buildView({ state, progress }: WidgetSource): BuildView | undefined {
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

/** The status and the widget line, set once and redrawn on every change. */
export class Widgets {
	private readonly source: WidgetSource;
	private tui: TUI | undefined;
	private widget: "stepper" | "plan" | undefined;

	constructor(source: WidgetSource) {
		this.source = source;
	}

	/** Forget the widget, e.g. when the session shuts down. */
	reset(): void {
		this.tui = undefined;
		this.widget = undefined;
	}

	refresh(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		const { state } = this.source;
		const theme = ctx.ui.theme as Paint;
		ctx.ui.setStatus(STATUS_KEY, modeStatus(state, theme));
		// The board shortcut only works in Pi's terminal UI.
		const hint = ctx.mode === "tui" ? BOARD_HINT : undefined;
		const arch = state.architecture;
		const wanted = state.mode === "architect" && arch ? "stepper" : state.plan || isApproved(arch) ? "plan" : undefined;
		const draw = (width: number, paint: Paint) => {
			const a = this.source.state.architecture;
			if (this.widget === "stepper") return a ? renderStepper(a, width, paint, hint) : undefined;
			const view = buildView(this.source);
			return view ? renderBuildProgress(view, width, paint, hint) : undefined;
		};
		if (!wanted) {
			if (this.widget) ctx.ui.setWidget(WIDGET_KEY, undefined);
			this.widget = undefined;
			this.tui = undefined;
			return;
		}
		if (ctx.mode !== "tui") {
			// RPC clients get plain lines; component factories are ignored there.
			this.widget = wanted;
			const line = draw(100, theme);
			ctx.ui.setWidget(WIDGET_KEY, line === undefined ? undefined : [line]);
			return;
		}
		if (this.widget === wanted && this.tui) {
			this.tui.requestRender();
			return;
		}
		this.widget = wanted;
		ctx.ui.setWidget(WIDGET_KEY, (t, th) => {
			this.tui = t;
			return new LineComponent((width) => draw(width, th as Paint));
		});
	}
}

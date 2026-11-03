// A diagram as a focusable pi-tui component that scrolls sideways, for overlays where a wide drawing must stay whole.
import { type Component, matchesKey } from "@earendil-works/pi-tui";
import { legend, type Painted, paintBody, paintRow } from "./render.ts";
import { clean, truncate, wrap } from "./text.ts";
import type { Diagram, DiagramTheme } from "./types.ts";

/** Columns moved per ←/→ press. */
export const SCROLL_STEP = 8;

export interface DiagramViewOptions {
	/** Called on esc or q. */
	onClose?: () => void;
}

/**
 * Title, drawing, caption and legend. When the drawing is wider than the view, ←/→ (or h/l) scroll it, home/end
 * jump to the edges, and a footer shows which columns are visible.
 */
export class DiagramView implements Component {
	private diagram: Diagram;
	private readonly theme: DiagramTheme;
	private readonly options: DiagramViewOptions;
	private painted: Painted;
	private offset = 0;
	private lastWidth = 0;

	constructor(diagram: Diagram, theme: DiagramTheme, options: DiagramViewOptions = {}) {
		this.diagram = diagram;
		this.theme = theme;
		this.options = options;
		this.painted = paintBody(diagram.body);
	}

	/** First visible column of the drawing. */
	get scroll(): number {
		return this.offset;
	}

	setDiagram(diagram: Diagram): void {
		this.diagram = diagram;
		this.painted = paintBody(diagram.body);
		this.offset = 0;
	}

	private maxScroll(width: number): number {
		return Math.max(0, this.painted.grid.width - width);
	}

	handleInput(data: string): void {
		const max = this.maxScroll(this.lastWidth || this.painted.grid.width);
		if (matchesKey(data, "left") || data === "h") this.offset = Math.max(0, this.offset - SCROLL_STEP);
		else if (matchesKey(data, "right") || data === "l") this.offset = Math.min(max, this.offset + SCROLL_STEP);
		else if (matchesKey(data, "home") || data === "0") this.offset = 0;
		else if (matchesKey(data, "end") || data === "$") this.offset = max;
		else if (matchesKey(data, "escape") || data === "q") this.options.onClose?.();
	}

	render(width: number): string[] {
		const w = Math.max(1, Math.floor(width));
		this.lastWidth = w;
		const { theme } = this;
		const p = this.painted;
		this.offset = Math.min(this.offset, this.maxScroll(w));
		const out = [theme.fg("accent", theme.bold(truncate(clean(this.diagram.title) || "Diagram", w))), ""];
		for (let r = 0; r < p.grid.height; r++) out.push(paintRow(p, r, this.offset, w, theme));
		const caption = this.diagram.caption ? clean(this.diagram.caption) : "";
		if (caption) out.push("", ...wrap(caption, w, 6).map((line) => theme.fg("dim", line)));
		const key = legend(p.statuses, theme);
		if (key.width && key.width <= w) out.push("", key.text);
		if (p.grid.width > w) {
			const from = this.offset + 1;
			const to = Math.min(p.grid.width, this.offset + w);
			const left = this.offset > 0 ? "◀ " : "  ";
			const right = to < p.grid.width ? " ▶" : "  ";
			out.push("", theme.fg("dim", truncate(`${left}cols ${from}–${to} of ${p.grid.width}${right}  ←/→ scroll`, w)));
		}
		return out;
	}

	invalidate(): void {}
}

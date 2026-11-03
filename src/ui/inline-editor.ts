import { Editor, stripTerminalSequences, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { Paint } from "./paint.ts";
import { raw, type Line } from "./spans.ts";

/** Pi's editor theme from our paint. Looked up on every render, so it follows theme changes. */
export function editorTheme(paint: Paint): EditorTheme {
	return {
		borderColor: (s) => paint.fg("borderAccent", s),
		selectList: {
			selectedPrefix: (s) => paint.fg("accent", s),
			selectedText: (s) => paint.fg("accent", s),
			description: (s) => paint.fg("muted", s),
			scrollInfo: (s) => paint.fg("dim", s),
			noMatch: (s) => paint.fg("warning", s),
		},
	};
}

/**
 * A text editor that lives inside a card: Pi's `Editor` without padding, its lines handed out as spans.
 * The owner forwards keys and focus to it.
 */
export class InlineEditor {
	readonly editor: Editor;

	constructor(tui: TUI, paint: Paint, text: string, onSubmit: (text: string) => void) {
		this.editor = new Editor(tui, editorTheme(paint), { paddingX: 0 });
		this.editor.setText(text);
		this.editor.onSubmit = onSubmit;
	}

	set focused(value: boolean) {
		this.editor.focused = value;
	}

	get text(): string {
		return this.editor.getText();
	}

	handleInput(data: string): void {
		this.editor.handleInput(data);
	}

	lines(width: number): Line[] {
		return this.editor.render(Math.max(1, width)).map((line) => [raw(line, stripTerminalSequences(line))]);
	}
}

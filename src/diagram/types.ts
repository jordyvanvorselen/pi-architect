// What the model sends: a diagram it drew itself, as Unicode text.
import { type Static, Type } from "typebox";

export const DiagramSchema = Type.Object({
	title: Type.String({ description: 'Short title, e.g. "Panel event flow".' }),
	body: Type.String({
		description: "The Unicode drawing, lines separated by \\n. Spaces only, no tabs or colour codes.",
	}),
	caption: Type.Optional(Type.String({ description: "One or two sentences on what the diagram shows." })),
});

export type Diagram = Static<typeof DiagramSchema>;

/** Theme colour tokens the renderer uses. All exist in Pi's theme. */
export type DiagramColor =
	"accent" | "borderMuted" | "borderAccent" | "muted" | "dim" | "success" | "warning" | "error";

/** The parts of Pi's `Theme` the renderer needs. `strikethrough` marks removed parts when present. */
export interface DiagramTheme {
	fg(color: DiagramColor, text: string): string;
	bold(text: string): string;
	strikethrough?(text: string): string;
}

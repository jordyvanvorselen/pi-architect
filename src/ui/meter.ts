import type { Level } from "../state/types.ts";
import type { Color } from "./paint.ts";
import { sp, type Span } from "./spans.ts";

/** Green for 1 and 2, yellow for 3, red for 4 and 5. */
export function levelColor(level: number): Color {
	return level <= 2 ? "success" : level === 3 ? "warning" : "error";
}

/** `▰▰▱▱▱`: the filled part in the level's colour, the rest dim. */
export function meter(level: Level | number): Span[] {
	const n = Math.min(5, Math.max(0, Math.round(level)));
	return [sp("▰".repeat(n), levelColor(n)), sp("▱".repeat(5 - n), "dim")];
}

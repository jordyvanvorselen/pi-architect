import type { BoardTab } from "./model.ts";

/** A comment the user wrote on one board item. Sent to the agent when the board closes. */
export interface BoardComment {
	tab: BoardTab;
	/** The item's key, so the comment follows the item when the board updates. */
	key: string;
	/** How the agent reads the item: `q1`, `d2`, `slice 3 (s3)`, `brief goal`. */
	ref: string;
	/** The question, title or text the item is about. */
	label?: string;
	text: string;
}

/**
 * One user message with every comment and the item it is about:
 *
 * ```
 * Board comments:
 * - q2 "How long do dedup keys stay unique?": per day is fine, but use the panel's time zone
 * - slice 3 (s3) "Store dedup key": also backfill old rows
 * ```
 *
 * Lines after the first of a comment are indented under it, so the list stays a list.
 */
export function boardMessage(comments: readonly BoardComment[]): string {
	const lines = comments.map((c) => {
		const about = c.label ? `${c.ref} "${c.label.replace(/"/g, "'")}"` : c.ref;
		const text = c.text
			.trim()
			.split("\n")
			.map((l, i) => (i ? `  ${l}` : l))
			.join("\n");
		return `- ${about}: ${text}`;
	});
	return `Board comments:\n${lines.join("\n")}`;
}

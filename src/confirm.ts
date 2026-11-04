import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The answer that keeps everything, first so that it is the default. */
export const KEEP = "No, keep it";

/**
 * Ask before something that discards work. Pi's confirm dialog puts Yes first, so a stray ↵ would discard:
 * this asks with a list that starts on No instead. True only when the user picked `yes`.
 */
export async function confirmDiscard(ctx: ExtensionContext, title: string, message: string, yes: string) {
	const picked = await ctx.ui.select(`${title}\n${message}`, [KEEP, yes]);
	return picked === yes;
}

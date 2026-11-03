import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { Paint } from "../paint.ts";
import { boardMessage, type BoardComment } from "./comments.ts";
import { BoardScreen } from "./component.ts";
import type { BoardData, BoardTab } from "./model.ts";
import { boardOverlay } from "./screen.ts";

export { boardMessage, type BoardComment } from "./comments.ts";
export { BoardScreen, type BoardOptions } from "./component.ts";
export { TABS, type BoardData, type BoardTab } from "./model.ts";

/** Opens the board. Pi does not bind it by default. */
export const BOARD_SHORTCUT = "ctrl+alt+b";
/** The hint the widgets show for it. */
export const BOARD_HINT = `${BOARD_SHORTCUT} board`;

export interface OpenBoardOptions {
	/** The current data, read again on every update. */
	data: () => BoardData;
	/** Sends the comments to the agent as one user message. Pi's `sendUserMessage`. */
	send: (text: string, options?: { deliverAs: "steer" | "followUp" }) => void;
	/** Pi's markdown theme, for the Plan tab. Falls back to one made from the theme colours. */
	markdown?: MarkdownTheme;
	tab?: BoardTab;
	/** Called with the open board, and with undefined when it closes, so the caller can push updates. */
	onOpen?: (board: BoardScreen | undefined) => void;
}

/** Markdown styles from our colours, for when Pi's own markdown theme is not available. */
export function paintMarkdownTheme(paint: Paint): MarkdownTheme {
	return {
		heading: (s) => paint.fg("accent", paint.bold(s)),
		link: (s) => paint.fg("accent", s),
		linkUrl: (s) => paint.fg("dim", s),
		code: (s) => paint.fg("accent", s),
		codeBlock: (s) => paint.fg("toolOutput", s),
		codeBlockBorder: (s) => paint.fg("borderMuted", s),
		quote: (s) => paint.fg("muted", s),
		quoteBorder: (s) => paint.fg("borderMuted", s),
		hr: (s) => paint.fg("borderMuted", s),
		listBullet: (s) => paint.fg("accent", s),
		bold: (s) => paint.bold(s),
		italic: (s) => s,
		strikethrough: (s) => s,
		underline: (s) => s,
	};
}

/** Pi's markdown theme, which follows theme changes. Undefined where Pi's theme is not set up, as in tests. */
export async function loadMarkdownTheme(): Promise<MarkdownTheme | undefined> {
	try {
		const theme = (await import("@earendil-works/pi-coding-agent")).getMarkdownTheme();
		theme.heading(""); // Its styles read Pi's theme lazily, so this fails where there is none.
		return theme;
	} catch {
		return undefined;
	}
}

/**
 * Open the board as a fullscreen overlay and wait until the user closes it. Comments the user wrote go to
 * the agent as one user message: at once when it is idle, as a steer message when it is working, so it
 * reads them before its next step. Returns the comments, or undefined when the board could not open.
 */
export async function openBoard(ctx: ExtensionContext, options: OpenBoardOptions): Promise<BoardComment[] | undefined> {
	const data = options.data();
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify("The board needs Pi's interactive terminal. /plan shows the plan.", "info");
		return undefined;
	}
	if (!data.arch && !data.plan) {
		ctx.ui.notify("There is no architecture to show yet. /architect <feature> starts one.", "info");
		return undefined;
	}
	const markdown = options.markdown ?? (await loadMarkdownTheme());
	let size = { columns: 80, rows: 24 };
	let comments: BoardComment[];
	try {
		comments = await ctx.ui.custom<BoardComment[]>(
			(tui, theme, _keybindings, done) => {
				size = tui.terminal;
				const paint = theme as Paint;
				const board = new BoardScreen(tui, paint, {
					data: options.data,
					markdown: markdown ?? paintMarkdownTheme(paint),
					...(options.tab ? { tab: options.tab } : {}),
					done,
				});
				options.onOpen?.(board);
				return board;
			},
			{ overlay: true, overlayOptions: () => boardOverlay(size.columns, size.rows) },
		);
	} finally {
		options.onOpen?.(undefined);
	}
	if (comments.length) {
		const idle = ctx.isIdle();
		options.send(boardMessage(comments), idle ? undefined : { deliverAs: "steer" });
		const n = comments.length === 1 ? "1 board comment" : `${comments.length} board comments`;
		ctx.ui.notify(idle ? `Sent ${n} to the agent.` : `Queued ${n} for the agent's next step.`, "info");
	}
	return comments;
}

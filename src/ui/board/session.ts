import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BoardComment } from "./comments.ts";
import type { BoardScreen } from "./component.ts";

/** What `BoardSession.show` hands the function that opens the board. See `OpenBoardOptions`. */
export interface BoardHooks {
	comments: readonly BoardComment[];
	shouldOpen: () => boolean;
	onOpen: (board: BoardScreen | undefined) => void;
}

/**
 * The board and the inline screens of one session, so they never hide each other.
 *
 * - One board at a time. A second ctrl+alt+b while the first board is still loading does nothing.
 * - A decision card or review screen that opens while the board is open closes the board first. Pi would
 *   focus the screen behind the board's overlay, where a ↵ or esc would answer it unseen. The board's
 *   unsent comments stay as a draft and are back the next time the board opens.
 * - A board the user opens while a screen is open is read-only and sits over it, which is how `b` on a
 *   card or screen works. Any other board waits until no screen is open.
 */
export class BoardSession {
	private board: BoardScreen | undefined;
	private opening = false;
	private draft: BoardComment[] = [];
	private screens = 0;

	/** Redraw the open board, e.g. after the architecture changed. */
	update(): void {
		this.board?.update();
	}

	/** The comments kept from a board that closed for a screen. For tests. */
	get kept(): readonly BoardComment[] {
		return this.draft;
	}

	/**
	 * Open the board with `open`, unless one is open or opening. A board with comments starts with the draft.
	 * The guard is set before anything is awaited, so two quick presses open one board.
	 */
	async show(
		readOnly: boolean,
		open: (hooks: BoardHooks) => Promise<BoardComment[] | undefined>,
	): Promise<BoardComment[] | undefined> {
		if (this.board || this.opening) return undefined;
		this.opening = true;
		const draft = readOnly ? [] : this.draft;
		if (!readOnly) this.draft = [];
		let opened = false;
		try {
			return await open({
				comments: draft,
				shouldOpen: () => readOnly || this.screens === 0,
				onOpen: (board) => {
					if (board) opened = true;
					this.board = board;
				},
			});
		} finally {
			this.opening = false;
			this.board = undefined;
			if (!opened && draft.length) this.draft = [...draft, ...this.draft];
		}
	}

	/** Run a decision card or review screen. An open board closes first and keeps its comments as a draft. */
	async screen<T>(ctx: ExtensionContext, show: () => Promise<T>): Promise<T> {
		const board = this.board;
		if (board) {
			this.board = undefined;
			const kept = board.suspend();
			if (kept.length) {
				this.draft = kept;
				const n = kept.length === 1 ? "Your comment is" : `Your ${kept.length} comments are`;
				ctx.ui.notify(`The board closed so you can answer the agent. ${n} kept for when you open it again.`, "info");
			}
		}
		this.screens++;
		try {
			return await show();
		} finally {
			this.screens--;
		}
	}

	/** `ui`, run through `screen`. */
	guard<R, A>(
		ui: (request: R, ctx: ExtensionContext) => Promise<A>,
	): (request: R, ctx: ExtensionContext) => Promise<A> {
		return (request, ctx) => this.screen(ctx, () => ui(request, ctx));
	}
}

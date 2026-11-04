import type { BoardComment } from "./comments.ts";
import type { BoardScreen } from "./component.ts";

/** What `BoardSession.show` hands the function that opens the board. See `OpenBoardOptions`. */
export interface BoardHooks {
	onOpen: (board: BoardScreen | undefined) => void;
}

/**
 * The board of one session. One board at a time: a second ctrl+alt+b while the first board is still
 * loading does nothing.
 */
export class BoardSession {
	private board: BoardScreen | undefined;
	private opening = false;

	/** Redraw the open board, e.g. after the architecture changed. */
	update(): void {
		this.board?.update();
	}

	/**
	 * Open the board with `open`, unless one is open or opening. The guard is set before anything is awaited,
	 * so two quick presses open one board.
	 */
	async show(open: (hooks: BoardHooks) => Promise<BoardComment[] | undefined>): Promise<BoardComment[] | undefined> {
		if (this.board || this.opening) return undefined;
		this.opening = true;
		try {
			return await open({ onOpen: (board) => (this.board = board) });
		} finally {
			this.opening = false;
			this.board = undefined;
		}
	}
}

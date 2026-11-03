import { PHASE_LABEL } from "../state/phases.ts";
import type { ArchitectState } from "../state/types.ts";
import type { Paint } from "./paint.ts";

/** Footer status key. The mode is always visible there. */
export const STATUS_KEY = "architect";

/** `◆ architect · Decide` in architect mode, `▸ build` in build mode. */
export function modeStatus(state: ArchitectState, paint: Paint): string {
	const arch = state.architecture;
	if (state.mode === "build") {
		const ready = arch?.approvedAt !== undefined;
		return paint.fg("muted", "▸ build") + (ready ? paint.fg("dim", " · plan approved") : "");
	}
	const where = !arch
		? ""
		: arch.approvedAt !== undefined
			? " · plan approved"
			: ` · ${PHASE_LABEL[arch.phase]}${arch.status === "review" ? " · review" : ""}`;
	return paint.fg("accent", `◆ architect${where}`);
}

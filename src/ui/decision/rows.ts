import type { DecideDetails, DecideInput } from "../../tools/decide.ts";
import type { Paint } from "../paint.ts";

const title = (paint: Paint) => `${paint.fg("accent", "◆")} ${paint.fg("toolTitle", paint.bold("architect decide"))}`;

/** `◆ architect decide  Where do panel events get deduplicated? · 3 options`. Arguments may still stream in. */
export function decideCall(args: Partial<DecideInput> | undefined, paint: Paint): string {
	const question = typeof args?.question === "string" ? args.question.trim() : "";
	const count = Array.isArray(args?.options) ? args.options.length : 0;
	const parts = [
		...(question ? [paint.fg("text", question)] : []),
		...(count ? [paint.fg("dim", `${count} option${count === 1 ? "" : "s"}`)] : []),
	];
	return title(paint) + (parts.length ? `  ${parts.join(paint.fg("dim", " · "))}` : "");
}

/** The user's answer: the choice and comment, their own option, their question, or why there was none. */
export function decideResult(
	details: DecideDetails | undefined,
	text: string,
	isPartial: boolean,
	expanded: boolean,
	paint: Paint,
): string {
	if (isPartial) return paint.fg("warning", "◉ waiting for your choice…");
	if (!details) return paint.fg("error", `✗ ${text}`);
	const comment = details.comment ? paint.fg("muted", `  "${details.comment}"`) : "";
	const detail = expanded ? `\n${paint.fg("dim", text)}` : "";
	switch (details.outcome) {
		case "chosen": {
			const over =
				details.recommended && details.chosen !== details.recommended
					? paint.fg("dim", ` · over ★ ${details.recommended}`)
					: details.chosen === details.recommended
						? paint.fg("warning", " ★")
						: "";
			return `${paint.fg("success", "✓")} ${paint.fg("accent", paint.bold(details.chosen!))} ${paint.fg("text", details.title!)}${over}${comment}${detail}`;
		}
		case "own":
			return `${paint.fg("success", "✎")} ${paint.fg("muted", "your own option")} ${paint.fg("accent", paint.bold(details.chosen!))} ${paint.fg("text", details.title!)}${detail}`;
		case "asked":
			return `${paint.fg("accent", "?")} ${paint.fg("muted", "you asked")} ${paint.fg("text", `"${details.asked}"`)}${detail}`;
		case "closed":
			return paint.fg("dim", `■ ${details.id} closed without a choice · still open`);
		case "no-ui":
			return paint.fg("dim", `■ no interactive UI · ${details.id} asked in chat`);
	}
}

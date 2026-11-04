import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildOrder } from "./plan/order.ts";
import { PHASE_LABEL, type Phase } from "./state/phases.ts";
import { counts } from "./state/queries.ts";
import type { Architecture } from "./state/types.ts";

export interface ReviewRequest {
	arch: Architecture;
	phase: Phase;
	/** What the agent asks the user to check. */
	summary?: string;
	/** Aborts when the user interrupts the agent. Close the review screen when it fires. */
	signal?: AbortSignal;
	/** Blueprint: where approving writes the plan file, as the user should read it. */
	planPath?: string;
}

export type ReviewAnswer = { verdict: "approved"; comment?: string } | { verdict: "changes"; comment: string };

/**
 * Shows a phase to the user and waits for approve or request changes. Undefined means the user closed it
 * without a decision. Pass a different one to the extension to replace the screen; `architect_advance`
 * does the bookkeeping around it.
 */
export type ReviewUi = (request: ReviewRequest, ctx: ExtensionContext) => Promise<ReviewAnswer | undefined>;

const list = (items: readonly string[]) => (items.length ? items.join("; ") : "–");

/** The phase content as short text lines, for the simple review dialog. */
export function reviewLines(arch: Architecture, phase: Phase): string[] {
	const lines: string[] = [];
	switch (phase) {
		case "frame":
			lines.push(
				`Feature: ${arch.feature || "–"}`,
				`Goal: ${arch.brief.goal || "–"}`,
				`Constraints: ${list(arch.brief.constraints)}`,
				`Out of scope: ${list(arch.brief.outOfScope)}`,
				`Done when: ${list(arch.brief.doneWhen)}`,
			);
			break;
		case "explore":
			// Big picture first: the diagrams, then the details.
			for (const d of arch.diagrams) if (d.phase === "explore") lines.push(`▣ ${d.title}`);
			for (const m of arch.modules) lines.push(`${m.role.padEnd(7)} ${m.path}${m.note ? ` – ${m.note}` : ""}`);
			for (const f of arch.findings) lines.push(`• ${f.text}`);
			break;
		case "decide":
			for (const d of arch.decisions) {
				const chosen = d.options.find((o) => o.id === d.chosen);
				lines.push(
					`${d.question} → ${chosen ? `${chosen.id} ${chosen.title}` : "open"}${d.comment ? ` (${d.comment})` : ""}`,
				);
			}
			if (!arch.decisions.length) lines.push("No open questions.");
			break;
		case "design":
			for (const d of arch.diagrams) lines.push(`▣ ${d.title}`);
			if (!arch.diagrams.length) lines.push("No diagrams.");
			break;
		case "slice": {
			// Numbered by build order, like the review screen and the plan file.
			const order = buildOrder(arch.slices);
			const number = new Map(order.map((o) => [o.slice.id, o.number]));
			for (const { number: n, slice: s } of order) {
				const after = s.dependsOn.map((d) => number.get(d) ?? d).join(", ");
				lines.push(`${n}. ${s.title}${after ? ` (after ${after})` : ""}`);
			}
			break;
		}
		case "blueprint": {
			const c = counts(arch);
			lines.push(
				`${arch.feature}: ${arch.brief.goal}`,
				`${arch.modules.length} modules · ${c.decided} decisions · ${arch.diagrams.length} diagrams · ${arch.slices.length} slices`,
				...arch.risks.map((r) => `⚠ ${r.severity} ${r.text}`),
			);
			break;
		}
	}
	return lines;
}

const APPROVE = "Approve";
const CHANGES = "Request changes";

/** A placeholder review: the phase as text in a select dialog, then a comment for requested changes. */
export const selectReview: ReviewUi = async ({ arch, phase, summary, signal }, ctx) => {
	const label = PHASE_LABEL[phase];
	const title = [`Review ${label}${summary ? `: ${summary}` : ""}`, "", ...reviewLines(arch, phase)].join("\n");
	const opts = signal ? { signal } : undefined;
	const choice = await ctx.ui.select(title, [`${APPROVE} ${label}`, CHANGES], opts);
	if (choice === undefined) return undefined;
	if (choice.startsWith(APPROVE)) return { verdict: "approved" };
	const comment = await ctx.ui.input(`What should change in ${label}?`, "your comment", opts);
	if (comment === undefined) return undefined;
	return { verdict: "changes", comment: comment.trim() };
};

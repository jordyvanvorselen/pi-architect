// Checks a diagram from the model before the user sees it. Errors reject the diagram with findings precise enough
// for the model to redraw it; warnings are shown but accepted.
import { type DiagramFinding, lintBody } from "./lint.ts";
import { MARKER_ALIASES } from "./markers.ts";
import { type DiagramRepair, repairBody } from "./repair.ts";
import { clean, width } from "./text.ts";
import type { Diagram } from "./types.ts";

export type { DiagramFinding, Severity } from "./lint.ts";
export type { DiagramRepair } from "./repair.ts";

/** Widest body the guide asks for. Wider diagrams scroll or get cut in narrow terminals. */
export const DEFAULT_MAX_WIDTH = 100;
/** Most findings returned. The counts still cover all of them. */
export const MAX_FINDINGS = 10;
const TALL = 60;

export interface ValidateOptions {
	/** Widest line allowed, in columns. Default 100. */
	maxWidth?: number;
}

export interface DiagramCheck {
	/** No errors: the diagram can be shown. Warnings may remain. */
	ok: boolean;
	/** The diagram with its body tidied (trailing spaces, blank edges, common indent). Absent when the shape is wrong. */
	diagram: Diagram | undefined;
	/** Most severe first, at most `MAX_FINDINGS`. `line`/`col` are 1-based in the body as sent; 0 = whole diagram. */
	findings: DiagramFinding[];
	errors: number;
	warnings: number;
	/**
	 * Slips the checker repaired before linting, like a corner one column off. The diagram and the findings
	 * are those of the repaired drawing. `line`/`col` are where the repair was, in the body as sent.
	 */
	repairs: DiagramRepair[];
	/** Model-readable verdict with every finding, for the tool result. */
	summary: string;
}

/**
 * Check the shape of `input`, then lint the drawing: line widths, tabs, colour codes, and alignment (boxes that do
 * not close, broken sides, junctions with a missing arm, arrows that miss).
 */
export function validateDiagram(input: unknown, options: ValidateOptions = {}): DiagramCheck {
	const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
	const findings: DiagramFinding[] = [];
	const whole = (severity: DiagramFinding["severity"], message: string) =>
		findings.push({ line: 0, col: 0, severity, message });

	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		whole("error", "A diagram must be an object: { title, body, caption? }.");
		return verdict(findings, undefined, []);
	}
	const raw = input as Record<string, unknown>;
	if (typeof raw.title !== "string" || !clean(raw.title)) whole("error", "title: give the diagram a short title.");
	if (raw.caption !== undefined && typeof raw.caption !== "string") whole("error", "caption: must be text.");
	if (typeof raw.body !== "string") {
		whole("error", "body: must be the drawing as text, lines separated by \\n.");
		return verdict(findings, undefined, []);
	}
	const body = raw.body.replace(/\r\n?/g, "\n");
	if (!body.trim()) whole("error", "body: the drawing is empty.");
	else if (!body.includes("\n") && body.includes("\\n")) {
		whole("error", "body: has \\n as text but no line breaks. Send real newlines (the JSON escape \\n, not \\\\n).");
	}
	const sent = body.split("\n").map((l) => l.trimEnd());
	// Unambiguous one-column slips are repaired first, so the model does not redraw a diagram for them.
	// eslint-disable-next-line no-control-regex -- a drawing with control characters is not repaired
	const repairable = body.trim() !== "" && !sent.some((l) => /[\t\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(l));
	const { lines, repairs } = repairable ? repairBody(sent) : { lines: sent, repairs: [] };

	const tabs = lines.flatMap((l, i) => (l.includes("\t") ? [i] : []));
	if (tabs.length) {
		const first = tabs[0]!;
		findings.push({
			line: first + 1,
			col: width(lines[first]!.slice(0, lines[first]!.indexOf("\t"))) + 1,
			severity: "error",
			message: `tab character${tabs.length > 1 ? `s on lines ${list(tabs)}` : ""}: use spaces, tabs have no fixed width.`,
		});
	}
	// eslint-disable-next-line no-control-regex -- detecting them is the point
	const control = lines.flatMap((l, i) => (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(l) ? [i] : []));
	if (control.length) {
		findings.push({
			line: control[0]! + 1,
			col: 0,
			severity: "error",
			message: `control characters or colour codes on line${control.length > 1 ? "s" : ""} ${list(control)}: send plain text, the extension adds the colours.`,
		});
	}

	const wide = lines.map((l, i) => ({ line: i, cols: width(l) })).filter((l) => l.cols > maxWidth);
	if (wide.length) {
		const widest = wide.reduce((a, b) => (b.cols > a.cols ? b : a));
		const shown = wide.slice(0, 4).map((l) => `line ${l.line + 1} (${l.cols})`);
		findings.push({
			line: widest.line + 1,
			col: maxWidth + 1,
			severity: "error",
			message: `${wide.length} line${wide.length > 1 ? "s are" : " is"} wider than ${maxWidth} cols: ${shown.join(", ")}${wide.length > 4 ? ", …" : ""}. Stack boxes top to bottom, shorten labels or split the diagram.`,
		});
	}

	const drawn = lines.filter((l) => l.trim()).length;
	if (drawn > TALL)
		whole("warning", `the drawing is ${drawn} lines tall. Consider splitting it into smaller diagrams.`);

	for (const [i, line] of lines.entries()) {
		for (const match of line.matchAll(/\[([a-z]+)\]/gi)) {
			const suggestion = MARKER_ALIASES[match[1]!.toLowerCase()];
			if (!suggestion) continue;
			findings.push({
				line: i + 1,
				col: width(line.slice(0, match.index)) + 1,
				severity: "warning",
				message: `${match[0]} is not a status marker: use ${suggestion}.`,
			});
		}
	}

	if (!tabs.length && body.trim()) findings.push(...lintBody(lines));

	const diagram: Diagram | undefined =
		typeof raw.title === "string"
			? {
					title: clean(raw.title),
					body: normalizeBody(repairs.length ? lines.join("\n") : body),
					...(typeof raw.caption === "string" && raw.caption.trim() ? { caption: raw.caption.trim() } : {}),
				}
			: undefined;
	return verdict(findings, diagram, repairs);
}

/** Tidy a drawing without moving anything relative to anything else. */
export function normalizeBody(body: string): string {
	const lines = body
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((l) => l.trimEnd());
	while (lines.length && !lines[0]) lines.shift();
	while (lines.length && !lines[lines.length - 1]) lines.pop();
	const indent = Math.min(...lines.filter(Boolean).map((l) => l.length - l.trimStart().length));
	return lines.map((l) => (Number.isFinite(indent) ? l.slice(indent) : l)).join("\n");
}

function verdict(all: DiagramFinding[], diagram: Diagram | undefined, repairs: DiagramRepair[]): DiagramCheck {
	const sorted = [...all].sort(
		(a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) || a.line - b.line || a.col - b.col,
	);
	const errors = sorted.filter((f) => f.severity === "error").length;
	const warnings = sorted.length - errors;
	const findings = sorted.slice(0, MAX_FINDINGS);
	const ok = errors === 0 && diagram !== undefined;
	const counts = [count(errors, "error"), count(warnings, "warning")].filter(Boolean).join(", ");
	const head = ok
		? warnings
			? `Diagram accepted with ${counts}.`
			: "Diagram accepted."
		: `Diagram rejected: ${counts}. Fix the errors and send the whole diagram again.`;
	const rows = findings.map(
		(f) => `- ${f.line ? `line ${f.line}${f.col ? ` col ${f.col}` : ""} ` : ""}${f.severity}: ${f.message}`,
	);
	if (sorted.length > findings.length) rows.push(`- …and ${sorted.length - findings.length} more.`);
	return {
		ok,
		diagram: ok || diagram ? diagram : undefined,
		findings,
		errors,
		warnings,
		repairs,
		summary: [head, ...rows, ...repairLines(repairs, ok)].join("\n"),
	};
}

/** What the checker repaired, for the model: so it draws the same way when it revises the diagram. */
export function repairLines(repairs: readonly DiagramRepair[], accepted: boolean): string[] {
	if (!repairs.length) return [];
	const head = accepted
		? `Repaired ${count(repairs.length, "alignment slip")} before showing it. Keep these when you revise it:`
		: `Repaired ${count(repairs.length, "alignment slip")} already; the findings above are for the repaired drawing. Make these changes too:`;
	return [head, ...repairs.map((r) => `- line ${r.line} col ${r.col}: ${r.message}.`)];
}

function count(n: number, word: string): string {
	return n ? `${n} ${word}${n > 1 ? "s" : ""}` : "";
}

function list(rows: number[]): string {
	const shown = rows.slice(0, 6).map((r) => r + 1);
	return `${shown.join(", ")}${rows.length > 6 ? ", …" : ""}`;
}

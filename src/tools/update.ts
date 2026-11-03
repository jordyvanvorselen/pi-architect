import { Type, type Static, type TUnsafe } from "typebox";
import type { UpdateEvent } from "../state/events.ts";
import { PHASE_LABEL, phaseIndex } from "../state/phases.ts";
import { missing, nextId, slugify } from "../state/queries.ts";
import type { Architecture, Finding, ModuleRef, ModuleRole, Risk, Severity } from "../state/types.ts";

/** A plain string enum. Some providers reject the `anyOf` that a union of literals produces. */
export function stringEnum<T extends string>(values: readonly T[], description: string): TUnsafe<T> {
	return Type.Unsafe<T>({ type: "string", enum: [...values], description });
}

const List = (description: string) => Type.Array(Type.String(), { description });

export const UpdateParams = Type.Object(
	{
		feature: Type.Optional(
			Type.String({ description: 'Short feature name, e.g. "Dedupe panel events". Only when it has none yet.' }),
		),
		brief: Type.Optional(
			Type.Object(
				{
					goal: Type.Optional(Type.String({ description: "One or two sentences: what changes and for whom." })),
					constraints: Type.Optional(List("Replaces the list.")),
					out_of_scope: Type.Optional(List("Replaces the list.")),
					done_when: Type.Optional(List("Checkable outcomes. Replaces the list.")),
				},
				{ additionalProperties: false, description: "Frame only." },
			),
		),
		modules: Type.Optional(
			Type.Array(
				Type.Object(
					{
						path: Type.String({
							description: 'Module or directory, e.g. "src/ingest". Updates the module with this path.',
						}),
						role: stringEnum(
							["touched", "new", "context"] as const,
							"touched: changes. new: does not exist yet. context: read only.",
						),
						files: Type.Optional(List("Key files in the module.")),
						note: Type.Optional(Type.String({ description: "What matters here, in one sentence." })),
					},
					{ additionalProperties: false },
				),
				{ description: "Explore and later." },
			),
		),
		findings: Type.Optional(List("Key findings to add, one sentence each. Explore and later.")),
		risks: Type.Optional(
			Type.Array(
				Type.Object(
					{
						id: Type.Optional(Type.String({ description: 'Give an existing id, e.g. "r2", to change that risk.' })),
						text: Type.String(),
						severity: Type.Optional(stringEnum(["low", "medium", "high"] as const, "Default medium.")),
						mitigation: Type.Optional(Type.String()),
					},
					{ additionalProperties: false },
				),
			),
		),
		remove: Type.Optional(List("Ids of findings, risks or diagrams, or module paths, to remove.")),
	},
	{ additionalProperties: false },
);

export type UpdateInput = Static<typeof UpdateParams>;

const ALIASES: Record<string, string> = {
	outOfScope: "out_of_scope",
	doneWhen: "done_when",
	out_of_scope: "out_of_scope",
};
const LIST_KEYS = new Set(["constraints", "out_of_scope", "done_when", "findings", "remove", "files"]);

function parseJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!/^[[{]/.test(trimmed)) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function normalize(value: unknown, key?: string): unknown {
	value = parseJson(value);
	if (key && LIST_KEYS.has(key) && typeof value === "string") return [value];
	if (Array.isArray(value)) return value.map((item) => normalize(item));
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [rawKey, raw] of Object.entries(value)) {
		if (raw === null) continue;
		const name = ALIASES[rawKey] ?? rawKey;
		result[name] = normalize(raw, name);
	}
	return result;
}

/**
 * Models sometimes send camelCase keys, a JSON string instead of an object, or one string instead of a list.
 * Fold those into the schema shape. Validation still runs afterwards.
 */
export function prepareUpdateArgs(raw: unknown): UpdateInput {
	const args = normalize(raw);
	if (args && typeof args === "object" && !Array.isArray(args)) {
		const record = args as Record<string, unknown>;
		if (typeof record.risks === "string") record.risks = [{ text: record.risks }];
		if (record.risks && !Array.isArray(record.risks)) record.risks = [record.risks];
		if (record.modules && !Array.isArray(record.modules)) record.modules = [record.modules];
		return record as UpdateInput;
	}
	return {} as UpdateInput;
}

export interface UpdateDetails {
	phase: Architecture["phase"];
	changes: string[];
	missing: string[];
}

export interface UpdatePlan {
	event: Omit<UpdateEvent, "v">;
	text: string;
	details: UpdateDetails;
}

const clean = (items: readonly string[] | undefined) =>
	items === undefined ? undefined : items.map((s) => s.trim()).filter(Boolean);
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * Turn tool input into one update event plus a short result for the model. Pure.
 * Throws with a message for the model when the input does not fit the current phase.
 */
export function planUpdate(
	arch: Architecture,
	input: UpdateInput,
	has: (tool: string) => boolean = () => true,
): UpdatePlan {
	if (arch.approvedAt !== undefined) throw new Error("The plan is approved and final. Nothing can change now.");
	const phase = arch.phase;
	const label = PHASE_LABEL[phase];
	const index = phaseIndex(phase);
	const changes: string[] = [];
	const update: Omit<UpdateEvent, "v"> = { type: "update", phase };

	const feature = input.feature?.trim();
	if (feature) {
		if (phase !== "frame" && arch.feature)
			throw new Error(`The feature is named "${arch.feature}" and Frame is approved.`);
		update.feature = { name: feature, slug: slugify(feature) };
		changes.push(`named "${feature}"`);
	}

	if (input.brief) {
		if (phase !== "frame")
			throw new Error(
				"The brief is fixed once Frame is approved. Record new insight as a finding or a risk, or ask the user.",
			);
		const b = input.brief;
		const brief: NonNullable<UpdateEvent["brief"]> = {};
		const parts: string[] = [];
		if (b.goal !== undefined) {
			brief.goal = b.goal.trim();
			parts.push("goal");
		}
		const lists = [
			["constraints", clean(b.constraints), "constraint"],
			["outOfScope", clean(b.out_of_scope), "out of scope", "out of scope"],
			["doneWhen", clean(b.done_when), "done-when", "done-when"],
		] as const;
		for (const [key, value, word, many] of lists) {
			if (value === undefined) continue;
			brief[key] = value;
			parts.push(plural(value.length, word, many));
		}
		if (parts.length) {
			update.brief = brief;
			changes.push(`brief: ${parts.join(", ")}`);
		}
	}

	const exploring = (what: string) => {
		if (index < phaseIndex("explore")) throw new Error(`${what} belong to Explore. Finish the Frame first.`);
	};

	if (input.modules?.length) {
		exploring("Modules");
		const modules: ModuleRef[] = input.modules.map((m) => {
			const path = m.path.trim();
			if (!path) throw new Error("Every module needs a path.");
			const old = arch.modules.find((x) => x.path === path);
			const note = m.note?.trim() ?? old?.note;
			return { path, role: m.role as ModuleRole, files: clean(m.files) ?? old?.files ?? [], ...(note ? { note } : {}) };
		});
		const added = modules.filter((m) => !arch.modules.some((x) => x.path === m.path)).length;
		update.modules = modules;
		changes.push(
			added === modules.length ? `+${plural(added, "module")}` : `${plural(modules.length, "module")} (${added} new)`,
		);
	}

	const findings = clean(input.findings);
	if (findings?.length) {
		exploring("Findings");
		const ids = arch.findings.map((f) => f.id);
		update.findings = findings.map((text): Finding => {
			const id = nextId(ids, "f");
			ids.push(id);
			return { id, text };
		});
		changes.push(`+${plural(findings.length, "finding")} (${update.findings.map((f) => f.id).join(", ")})`);
	}

	if (input.risks?.length) {
		const ids = arch.risks.map((r) => r.id);
		const added: string[] = [];
		const changed: string[] = [];
		update.risks = input.risks.map((r): Risk => {
			const text = r.text.trim();
			if (!text) throw new Error("Every risk needs a text.");
			const old = r.id ? arch.risks.find((x) => x.id === r.id) : undefined;
			if (r.id && !old) throw new Error(`Unknown risk ${r.id}. Risks: ${ids.join(", ") || "none"}.`);
			const id = old?.id ?? nextId(ids, "r");
			if (!old) ids.push(id);
			(old ? changed : added).push(id);
			const mitigation = r.mitigation?.trim() ?? old?.mitigation;
			return {
				id,
				text,
				severity: (r.severity as Severity) ?? old?.severity ?? "medium",
				...(mitigation ? { mitigation } : {}),
			};
		});
		if (added.length) changes.push(`+${plural(added.length, "risk")} (${added.join(", ")})`);
		if (changed.length) changes.push(`changed ${changed.join(", ")}`);
	}

	const remove = clean(input.remove);
	if (remove?.length) {
		const known = new Set([
			...arch.findings.map((f) => f.id),
			...arch.risks.map((r) => r.id),
			...arch.modules.map((m) => m.path),
			...arch.diagrams.map((d) => d.id),
		]);
		const unknown = remove.filter((id) => !known.has(id));
		if (unknown.length) throw new Error(`Nothing to remove with id ${unknown.join(", ")}.`);
		update.remove = remove;
		changes.push(`removed ${remove.join(", ")}`);
	}

	if (!changes.length) throw new Error("Nothing to update. Give feature, brief, modules, findings, risks or remove.");

	const after = applyPreview(arch, update);
	const gaps = missing(after, has);
	const next = gaps.length
		? `${label} still needs ${gaps.join(", ")}.`
		: `${label} is ready: call architect_advance when the user should review it.`;
	return { event: update, text: `Updated ${changes.join(", ")}. ${next}`, details: { phase, changes, missing: gaps } };
}

/** The architecture as it will be after the update, for the readiness note. Only the fields `missing` reads. */
function applyPreview(arch: Architecture, update: Omit<UpdateEvent, "v">): Architecture {
	return {
		...arch,
		...(update.feature ? { feature: update.feature.name } : {}),
		brief: { ...arch.brief, ...update.brief },
		modules: [
			...arch.modules.filter((m) => !update.modules?.some((u) => u.path === m.path)),
			...(update.modules ?? []),
		].filter((m) => !update.remove?.includes(m.path)),
	};
}

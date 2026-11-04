import { moduleFiles } from "../../state/queries.ts";
import type { ModuleRef, ModuleRole } from "../../state/types.ts";
import type { Color } from "../paint.ts";
import { clipLine, lineWidth, sp, wrap, type Line } from "../spans.ts";
import { risks, section, trim, wrapIndented, type ReviewBody } from "./common.ts";
import { diagramLines } from "./diagram.ts";

export const ROLE_MARK: Record<ModuleRole, { glyph: string; color: Color; name: Color }> = {
	touched: { glyph: "●", color: "warning", name: "text" },
	new: { glyph: "+", color: "success", name: "success" },
	context: { glyph: "○", color: "dim", name: "muted" },
};

interface Node {
	name: string;
	children: Node[];
	module?: ModuleRef;
	/** Files listed under a module. */
	file?: boolean;
}

function child(parent: Node, name: string): Node {
	let node = parent.children.find((c) => c.name === name && !c.file);
	if (!node) {
		node = { name, children: [] };
		parent.children.push(node);
	}
	return node;
}

/**
 * Module paths as a tree. Files hang under their module, relative to it. A file that only repeats the module
 * path, like `todo.ts` under the module `src/todo.ts`, is left out, so a module that is a file shows as one.
 */
export function moduleTree(modules: readonly ModuleRef[]): Node {
	const root: Node = { name: "", children: [] };
	for (const module of modules) {
		const parts = module.path.split("/").filter(Boolean);
		let node = root;
		for (const part of parts) node = child(node, part);
		node.module = module;
		for (const file of moduleFiles(module)) {
			const relative = file.startsWith(`${module.path}/`) ? file.slice(module.path.length + 1) : file;
			if (!node.children.some((c) => c.file && c.name === relative))
				node.children.push({ name: relative, children: [], file: true });
		}
	}
	return collapse(root);
}

/** Join a folder that holds only one folder with that folder: `packages/core/src`. */
function collapse(node: Node): Node {
	node.children = node.children.map(collapse);
	const only = node.children[0];
	if (node.name && !node.module && node.children.length === 1 && only && !only.file)
		return { ...only, name: `${node.name}/${only.name}` };
	return node;
}

function nodeLines(node: Node, prefix: string, last: boolean, top: boolean, width: number): Line[] {
	const branch = top ? "" : last ? "└─ " : "├─ ";
	const lead = [sp(prefix + branch, "borderMuted")];
	// A folder keeps its slash, also a folder module without files yet like `test/`.
	const folder = !node.file && (node.children.length > 0 || Boolean(node.module?.path.endsWith("/")));
	const name = folder ? `${node.name}/` : node.name;
	const mark = node.module ? ROLE_MARK[node.module.role] : undefined;
	const label: Line = node.file
		? [sp(name, "muted")]
		: mark
			? [sp(`${mark.glyph} `, mark.color), sp(name, mark.name, node.module!.role !== "context")]
			: [sp(name, "dim")];
	const head = [...lead, ...label];
	const lines: Line[] = [];
	const under = prefix + (top ? "" : last ? "   " : "│  ");
	const note = node.module?.note;
	const noteIndent = under + (node.children.length ? "│  " : "   ");
	if (note && lineWidth(head) + 2 + lineWidth([sp(note)]) <= width) lines.push([...head, sp("  "), sp(note, "muted")]);
	else {
		lines.push(clipLine(head, width));
		if (note) lines.push(...wrapIndented(note, noteIndent, width, "muted"));
	}
	node.children.forEach((c, i) => lines.push(...nodeLines(c, under, i === node.children.length - 1, false, width)));
	return lines;
}

/** The module map: a tree of the modules with touched, new and context markers, and their files. */
export function moduleMap(modules: readonly ModuleRef[], width: number): Line[] {
	if (!modules.length) return [[sp("no modules yet", "warning")]];
	const tree = moduleTree(modules);
	return tree.children.flatMap((c) => nodeLines(c, "", true, true, width));
}

export const legend: Line = [
	sp("● ", ROLE_MARK.touched.color),
	sp("touched  ", "dim"),
	sp("+ ", ROLE_MARK.new.color),
	sp("new  ", "dim"),
	sp("○ ", ROLE_MARK.context.color),
	sp("context", "dim"),
];

/** Explore: the big picture first (diagrams of the existing code, risks), then the module map and the findings. */
export const exploreBody: ReviewBody = (arch, width, paint) => {
	const lines: Line[] = [];
	const diagrams = arch.diagrams.filter((d) => d.phase === "explore");
	if (diagrams.length)
		lines.push(
			...section(
				"Diagrams",
				diagrams.flatMap((d) => diagramLines(d, width, paint)),
				width,
			),
		);
	lines.push(...risks(arch, width));
	lines.push(...section("Modules", moduleMap(arch.modules, width), width, legend));
	const findings = arch.findings.flatMap((f) => {
		const tag = `${f.id} `.padEnd(4);
		return wrap(f.text, Math.max(1, width - tag.length)).map((l, i) => [
			sp(i ? " ".repeat(tag.length) : tag, "dim"),
			sp(l, "text"),
		]);
	});
	if (findings.length) lines.push(...section("Findings", findings, width));
	return trim(lines);
};

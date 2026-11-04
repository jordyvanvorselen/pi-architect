/**
 * Read-only git. Global options, subcommands and each subcommand's options are allowlisted.
 * Git accepts unambiguous prefixes of long options (`--out` for `--output`), so options must be written in full.
 */
import { has, options, type ArgRule, type OptionSpec, type ParsedArgs } from "./options.ts";
import type { Word } from "./shell.ts";

/** Merges option specs. */
function spec(...parts: OptionSpec[]): OptionSpec {
	const join = (key: "flags" | "values" | "attached") => parts.map((p) => p[key] ?? "").join("");
	const list = (key: "long" | "longValues" | "longOptional") => parts.flatMap((p) => p[key] ?? []);
	return {
		flags: join("flags"),
		values: join("values"),
		attached: join("attached"),
		long: list("long"),
		longValues: list("longValues"),
		longOptional: list("longOptional"),
		numeric: parts.some((p) => p.numeric),
		globs: true,
	};
}

/** Options for showing a diff, shared by diff, log, show and friends. `--output`, `--ext-diff` and `-O` are left out. */
const DIFF: OptionSpec = {
	flags: "pusRzwbaW",
	values: "SG",
	attached: "MCBU",
	long: [
		"patch",
		"no-patch",
		"raw",
		"patch-with-raw",
		"patch-with-stat",
		"numstat",
		"shortstat",
		"summary",
		"name-only",
		"name-status",
		"full-index",
		"binary",
		"no-color",
		"no-renames",
		"find-copies-harder",
		"text",
		"ignore-space-at-eol",
		"ignore-space-change",
		"ignore-all-space",
		"ignore-blank-lines",
		"ignore-cr-at-eol",
		"minimal",
		"patience",
		"histogram",
		"no-ext-diff",
		"no-textconv",
		"cached",
		"staged",
		"merge-base",
		"no-index",
		"exit-code",
		"quiet",
		"check",
		"no-prefix",
		"default-prefix",
		"compact-summary",
		"irreversible-delete",
		"pickaxe-all",
		"pickaxe-regex",
		"function-context",
		"no-relative",
		"no-color-moved",
		"indent-heuristic",
		"no-indent-heuristic",
	],
	longValues: [
		"diff-filter",
		"src-prefix",
		"dst-prefix",
		"line-prefix",
		"inter-hunk-context",
		"diff-algorithm",
		"anchored",
		"word-diff-regex",
		"stat-width",
		"stat-name-width",
		"stat-graph-width",
		"stat-count",
		"ignore-matching-lines",
		"find-object",
		"rotate-to",
		"skip-to",
		"ws-error-highlight",
	],
	longOptional: [
		"stat",
		"dirstat",
		"color",
		"word-diff",
		"color-words",
		"color-moved",
		"color-moved-ws",
		"find-renames",
		"find-copies",
		"break-rewrites",
		"abbrev",
		"submodule",
		"ignore-submodules",
		"relative",
		"unified",
	],
};

/** Options for walking and showing history. `--show-signature` is left out: it runs gpg. */
const LOG: OptionSpec = {
	flags: "iEFPgmctr",
	values: "nL",
	numeric: true,
	long: [
		"oneline",
		"graph",
		"all",
		"reverse",
		"follow",
		"no-decorate",
		"source",
		"date-order",
		"author-date-order",
		"topo-order",
		"left-right",
		"left-only",
		"right-only",
		"cherry-pick",
		"cherry-mark",
		"cherry",
		"boundary",
		"abbrev-commit",
		"no-abbrev-commit",
		"no-abbrev",
		"full-history",
		"simplify-by-decoration",
		"simplify-merges",
		"dense",
		"sparse",
		"parents",
		"children",
		"walk-reflogs",
		"regexp-ignore-case",
		"extended-regexp",
		"fixed-strings",
		"perl-regexp",
		"basic-regexp",
		"invert-grep",
		"all-match",
		"relative-date",
		"use-mailmap",
		"mailmap",
		"no-mailmap",
		"full-diff",
		"count",
		"first-parent",
		"merges",
		"no-merges",
		"no-min-parents",
		"no-max-parents",
		"do-walk",
		"not",
		"no-expand-tabs",
		"no-notes",
		"cc",
		"combined-all-paths",
		"remove-empty",
		"reflog",
		"root",
		"no-commit-id",
		"show-pulls",
		"log-size",
	],
	longValues: [
		"format",
		"max-count",
		"skip",
		"since",
		"after",
		"until",
		"before",
		"author",
		"committer",
		"grep",
		"grep-reflog",
		"date",
		"glob",
		"exclude",
		"min-parents",
		"max-parents",
		"encoding",
		"since-as-filter",
		"decorate-refs",
		"decorate-refs-exclude",
		"diff-merges",
	],
	longOptional: [
		"decorate",
		"pretty",
		"expand-tabs",
		"notes",
		"show-notes",
		"branches",
		"tags",
		"remotes",
		"no-walk",
		"ancestry-path",
		"show-linear-break",
	],
};

const BLAME: OptionSpec = {
	flags: "bltsepwnfc",
	values: "L",
	attached: "MC",
	long: [
		"porcelain",
		"line-porcelain",
		"incremental",
		"root",
		"show-stats",
		"show-name",
		"show-number",
		"show-email",
		"color-lines",
		"color-by-age",
		"minimal",
		"reverse",
		"first-parent",
		"no-progress",
	],
	longValues: ["date", "contents", "ignore-rev", "ignore-revs-file", "encoding"],
	longOptional: ["abbrev"],
};

/** `git grep` without `-O`/`--open-files-in-pager`, which runs a program. */
const GREP: OptionSpec = {
	flags: "niwvlLchHEFPGoqzaIpW",
	values: "eABCmf",
	long: [
		"cached",
		"untracked",
		"no-index",
		"exclude-standard",
		"no-exclude-standard",
		"recurse-submodules",
		"text",
		"ignore-case",
		"word-regexp",
		"invert-match",
		"files-with-matches",
		"files-without-match",
		"name-only",
		"count",
		"full-name",
		"line-number",
		"column",
		"heading",
		"break",
		"and",
		"or",
		"not",
		"all-match",
		"extended-regexp",
		"basic-regexp",
		"fixed-strings",
		"perl-regexp",
		"only-matching",
		"quiet",
		"null",
		"show-function",
		"function-context",
		"no-color",
	],
	longValues: ["max-depth", "context", "after-context", "before-context", "threads", "max-count"],
	longOptional: ["color"],
};

const STATUS: OptionSpec = {
	flags: "sbzv",
	attached: "u",
	long: [
		"short",
		"branch",
		"long",
		"verbose",
		"show-stash",
		"ahead-behind",
		"no-ahead-behind",
		"renames",
		"no-renames",
		"no-column",
		"null",
	],
	longOptional: ["porcelain", "find-renames", "ignored", "untracked-files", "ignore-submodules", "column"],
};

/** Options `git branch` and `git tag` share when they list. */
const LIST: OptionSpec = {
	flags: "il",
	long: ["list", "ignore-case", "no-column", "no-color", "omit-empty"],
	longValues: ["contains", "no-contains", "merged", "no-merged", "points-at", "sort", "format"],
	longOptional: ["column", "color"],
};

/** `git branch` lists; `-v` is verbose here. */
const BRANCH: OptionSpec = {
	flags: "arv",
	long: ["all", "remotes", "verbose", "show-current", "no-abbrev"],
	longOptional: ["abbrev"],
};

/** `git tag` lists with `-n`. Its `-v` verifies a signature with gpg, so it is left out. */
const TAG: OptionSpec = { attached: "n" };

/** A subcommand with an allowlist, and a check on what was parsed. */
function sub(name: string, s: OptionSpec, then?: (p: ParsedArgs) => string | undefined): ArgRule {
	return options(`git ${name}`, s, then);
}

/** Subcommands that only read and have no option that writes or runs something. */
const PLAIN = [
	"rev-parse",
	"ls-files",
	"ls-tree",
	"merge-base",
	"name-rev",
	"count-objects",
	"show-ref",
	"for-each-ref",
	"describe",
	"check-ignore",
	"check-attr",
	"var",
	"version",
	"cherry",
	"show-branch",
];

/** Lists, and a name only together with -l/--list. */
function listOnly(command: "branch" | "tag", extra: OptionSpec): ArgRule {
	return sub(command, spec(LIST, extra), (p) =>
		p.positional.length && !has(p, "-l", "--list")
			? `git ${command} ${p.positional[0]!.value} creates a ${command}; use git ${command} --list 'pattern'`
			: undefined,
	);
}

const CONFIG_SCOPE: OptionSpec = {
	flags: "lz",
	long: [
		"global",
		"system",
		"local",
		"worktree",
		"show-origin",
		"show-scope",
		"name-only",
		"null",
		"includes",
		"no-includes",
		"bool",
		"int",
		"bool-or-int",
		"path",
	],
	longValues: ["file", "blob", "type", "default"],
};

/** `git config get/list` and the `--get`/`--list` modes. Every other form sets something. */
const config: ArgRule = (args) => {
	const first = args[0]?.value;
	if (first === "get")
		return sub(
			"config get",
			spec(CONFIG_SCOPE, { long: ["all", "regexp", "fixed-value"], longValues: ["value", "url"] }),
			(p) => (p.positional.length === 1 ? undefined : "git config get takes one name"),
		)(args.slice(1));
	if (first === "list")
		return sub("config list", CONFIG_SCOPE, (p) =>
			p.positional.length ? "git config list takes no names" : undefined,
		)(args.slice(1));
	return sub(
		"config",
		spec(CONFIG_SCOPE, {
			long: ["list", "get", "get-all", "get-regexp", "get-urlmatch", "get-color", "get-colorbool"],
		}),
		(p) => {
			if (has(p, "-l", "--list")) return p.positional.length ? "git config --list takes no names" : undefined;
			if (!has(p, "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool"))
				return "only git config get, list, --get and --list are allowed";
			return p.positional.length <= 2 ? undefined : "git config --get takes a name and an optional pattern";
		},
	)(args);
};

/** `git reflog`, `git reflog show` and `git reflog list`. A first word that is a subcommand could expire or delete. */
const reflog: ArgRule = (args) => {
	const first = args[0]?.value;
	if (first === "list") return args.length === 1 ? undefined : "git reflog list takes no arguments";
	if (first === "show") return sub("reflog show", spec(LOG))(args.slice(1));
	if (first !== undefined && !first.startsWith("-"))
		return `git reflog ${first} is not allowed; use git reflog show ${first}`;
	return sub("reflog", spec(LOG))(args);
};

const remote: ArgRule = (args) => {
	const first = args[0]?.value;
	if (first === undefined || (args.length === 1 && (first === "-v" || first === "--verbose"))) return undefined;
	if (first === "show") return options("git remote show", { flags: "n" })(args.slice(1));
	if (first === "get-url") return options("git remote get-url", { long: ["push", "all"] })(args.slice(1));
	return "only git remote, git remote -v, show and get-url are allowed";
};

const stash: ArgRule = (args) => {
	const first = args[0]?.value;
	if (first === "list") return sub("stash list", spec(LOG, DIFF))(args.slice(1));
	if (first === "show")
		return sub(
			"stash show",
			spec(DIFF, { long: ["include-untracked", "only-untracked", "no-include-untracked"] }),
		)(args.slice(1));
	return "only git stash list and git stash show are allowed";
};

const worktree: ArgRule = (args) =>
	args[0]?.value === "list"
		? options("git worktree list", { flags: "vz", long: ["porcelain", "verbose"], longValues: ["expire"] })(
				args.slice(1),
			)
		: "only git worktree list is allowed";

/** `git cat-file` without `--textconv` and `--filters`, which run configured programs. */
const CAT_FILE: OptionSpec = {
	flags: "tsepZ",
	long: ["batch-all-objects", "buffer", "unordered", "follow-symlinks", "allow-unknown-type"],
	longOptional: ["batch", "batch-check"],
	globs: true,
};

const SUBCOMMANDS: Record<string, ArgRule> = {
	status: sub("status", spec(STATUS)),
	log: sub("log", spec(LOG, DIFF)),
	show: sub("show", spec(LOG, DIFF)),
	diff: sub("diff", spec(DIFF)),
	"diff-tree": sub("diff-tree", spec(LOG, DIFF, { long: ["stdin"] })),
	"rev-list": sub(
		"rev-list",
		spec(LOG, { long: ["objects", "objects-edge", "no-object-names", "in-commit-order", "timestamp", "header"] }),
	),
	shortlog: sub(
		"shortlog",
		spec(LOG, { flags: "nse", attached: "w", long: ["numbered", "summary", "email"], longValues: ["group"] }),
	),
	blame: sub("blame", spec(BLAME)),
	annotate: sub("annotate", spec(BLAME)),
	grep: sub("grep", spec(GREP)),
	"cat-file": options("git cat-file", CAT_FILE),
	branch: listOnly("branch", BRANCH),
	tag: listOnly("tag", TAG),
	config,
	reflog,
	remote,
	stash,
	worktree,
	...Object.fromEntries(PLAIN.map((name) => [name, () => undefined])),
};

/** Global options that only change where git looks or how it prints. */
const GLOBAL_FLAGS = [
	"--no-pager",
	"-P",
	"--no-optional-locks",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--no-replace-objects",
];

export const git: ArgRule = (args: readonly Word[]) => {
	let i = 0;
	for (; i < args.length && args[i]!.value.startsWith("-"); i++) {
		const arg = args[i]!.value;
		if (arg === "--version") return args.length === 1 ? undefined : "use git --version on its own";
		if (arg === "-C") {
			const path = args[++i];
			if (!path || path.glob || path.value.startsWith("-")) return "git -C needs a directory";
			continue;
		}
		if (arg === "-c" || arg.startsWith("--config-env"))
			return `git ${arg.split("=")[0]} is not allowed: config can make git run programs`;
		if (!GLOBAL_FLAGS.includes(arg)) return `git ${arg.split("=")[0]} is not allowed in architect mode`;
	}
	const name = args[i];
	if (!name) return `git needs a read-only subcommand: ${Object.keys(SUBCOMMANDS).join(", ")}`;
	if (name.glob) return `quote "${name.value}"`;
	const rule = SUBCOMMANDS[name.value];
	if (!rule) return `git ${name.value} is not read-only`;
	const rest = args.slice(i + 1);
	if (rest.some((a) => a.value === "--help")) return "git --help opens a pager or browser; use -h for a short usage";
	// A glob that starts with a plain character can only match plain arguments, never an option.
	const glob = rest.find((a) => a.glob && !/^[A-Za-z0-9._/~]/.test(a.value));
	if (glob) return `quote "${glob.value}" or start it with ./`;
	return rule(rest);
};

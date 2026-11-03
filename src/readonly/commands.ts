import { parseCommandLine, type Redirect, type SimpleCommand, type Word } from "./shell.ts";

/** Checks the arguments of one command. Returns why it is not read-only, or undefined when it is. */
type ArgRule = (args: string[]) => string | undefined;

const ANY: ArgRule = () => undefined;

/** Flags that make the command write, run something or go interactive. Matches `--flag` and `--flag=value`. */
function denyFlags(command: string, long: string[], short = ""): ArgRule {
	return (args) => {
		for (const arg of args) {
			if (arg === "--") break;
			if (arg.startsWith("--")) {
				const name = arg.split("=")[0]!;
				if (long.includes(name)) return `${command} ${name} is not read-only`;
			} else if (short && /^-[A-Za-z]/.test(arg)) {
				const hit = [...arg.slice(1)].find((ch) => short.includes(ch));
				if (hit) return `${command} -${hit} is not read-only`;
			}
		}
		return undefined;
	};
}

const positional = (args: string[]) => args.filter((a) => !a.startsWith("-"));

function versionOnly(command: string): ArgRule {
	return (args) =>
		args.length === 1 && ["--version", "-v", "-V", "version"].includes(args[0]!)
			? undefined
			: `only "${command} --version" is allowed`;
}

/** Subcommands that only read. `rules` refines individual subcommands. */
function subcommands(command: string, allowed: string[], rules: Record<string, ArgRule> = {}): ArgRule {
	return (args) => {
		const sub = args[0];
		if (sub === undefined) return `${command} needs a read-only subcommand: ${allowed.join(", ")}`;
		if (sub === "--version" || sub === "-v" || sub === "--help" || sub === "help") return undefined;
		if (!allowed.includes(sub)) return `${command} ${sub} is not read-only`;
		return rules[sub]?.(args.slice(1));
	};
}

/** sed scripts that only print or delete lines from the output: `10,20p`, `/re/p`, `s/a/b/g`, `5q`. */
function safeSedScript(script: string): boolean {
	const address = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)`;
	const range = new RegExp(String.raw`^\s*(?:${address}(?:\s*,\s*${address})?)?\s*!?\s*[pdq=]?\s*$`);
	return script.split(/[;\n]/).every((part) => {
		if (range.test(part)) return true;
		const m = /^\s*(?:\d+(?:,\d+)?)?\s*s(.)/.exec(part);
		if (!m) return false;
		const delimiter = m[1]!;
		if (/[\s\\\n]/.test(delimiter)) return false;
		let rest = part.slice(m[0].length);
		for (let pieces = 0; pieces < 2; pieces++) {
			let j = 0;
			while (j < rest.length && rest[j] !== delimiter) j += rest[j] === "\\" ? 2 : 1;
			if (j >= rest.length) return false;
			rest = rest.slice(j + 1);
		}
		return /^[gpiI0-9]*\s*$/.test(rest);
	});
}

const sed: ArgRule = (args) => {
	const scripts: string[] = [];
	let sawScriptFlag = false;
	const files: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "-i" || arg.startsWith("--in-place") || /^-[a-zA-Z]*i/.test(arg)) return "sed -i edits files";
		if (arg === "-f" || arg.startsWith("--file")) return "sed -f is not allowed; give the script inline";
		if (arg === "-e" || arg === "--expression") {
			sawScriptFlag = true;
			scripts.push(args[++i] ?? "");
		} else if (arg.startsWith("--expression=")) {
			sawScriptFlag = true;
			scripts.push(arg.slice("--expression=".length));
		} else if (!arg.startsWith("-")) files.push(arg);
	}
	if (!sawScriptFlag && files.length) scripts.push(files.shift()!);
	if (!scripts.length) return "sed needs a script";
	return scripts.every(safeSedScript)
		? undefined
		: "only sed scripts that print, delete or substitute (p, d, q, s///g) are allowed; use read or grep instead";
};

const awk: ArgRule = (args) => {
	for (const arg of args) {
		if (arg === "-f" || arg.startsWith("--file")) return "awk -f is not allowed; give the program inline";
		if (arg === "-i" || arg.startsWith("--include")) return "awk -i is not allowed";
		if (/\bsystem\s*\(|\bgetline\b|[|>]|\bfflush\b|\bclose\s*\(/.test(arg))
			return "awk programs with system(), getline, pipes or > are not allowed";
	}
	return undefined;
};

/** `find` actions that run commands, delete files or write output files. */
const FIND_ACTIONS = ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"];
const find: ArgRule = (args) => {
	const bad = args.find((a) => FIND_ACTIONS.includes(a));
	return bad ? `find ${bad} is not read-only` : undefined;
};

const GIT_READ = [
	"status",
	"log",
	"show",
	"diff",
	"blame",
	"annotate",
	"shortlog",
	"describe",
	"rev-parse",
	"rev-list",
	"ls-files",
	"ls-tree",
	"ls-remote",
	"cat-file",
	"grep",
	"merge-base",
	"name-rev",
	"count-objects",
	"whatchanged",
	"show-ref",
	"show-branch",
	"for-each-ref",
	"cherry",
	"range-diff",
	"diff-tree",
	"diff-files",
	"diff-index",
	"check-ignore",
	"check-attr",
	"var",
	"version",
	"branch",
	"tag",
	"remote",
	"stash",
	"worktree",
	"config",
	"reflog",
	"notes",
	"submodule",
];

/** Options of `git branch` and `git tag` that take a value, so the next word is not a new name. */
const LIST_VALUE_OPTIONS = [
	"--contains",
	"--no-contains",
	"--merged",
	"--no-merged",
	"--points-at",
	"--sort",
	"--format",
];

function listOnly(command: string, denied: string[]): ArgRule {
	return (args) => {
		const listing = args.some((a) => a === "-l" || a === "--list");
		for (let i = 0; i < args.length; i++) {
			const arg = args[i]!;
			const name = arg.split("=")[0]!;
			if (
				denied.includes(name) ||
				(/^-[A-Za-z]+$/.test(arg) && [...arg.slice(1)].some((c) => denied.includes(`-${c}`)))
			)
				return `git ${command} ${arg} is not read-only`;
			if (LIST_VALUE_OPTIONS.includes(arg)) i++;
			else if (!arg.startsWith("-") && !listing)
				return `git ${command} ${arg} creates a ${command}; use git ${command} --list to list them`;
		}
		return undefined;
	};
}

const git: ArgRule = (args) => {
	let i = 0;
	// Global options before the subcommand.
	while (i < args.length && args[i]!.startsWith("-")) {
		const arg = args[i]!;
		if (arg === "--version" || arg === "--help") return undefined;
		if (arg === "-c" || arg.startsWith("--config-env") || arg.startsWith("--exec-path"))
			return `git ${arg} is not allowed in read-only mode`;
		if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") i += 2;
		else i++;
	}
	const rest = args.slice(i);
	for (const arg of rest) {
		if (arg.startsWith("--output") || arg === "-O" || arg.startsWith("--open-files-in-pager"))
			return `git ${arg.split("=")[0]} is not read-only`;
	}
	return subcommands("git", GIT_READ, {
		branch: listOnly("branch", [
			"-d",
			"-D",
			"-m",
			"-M",
			"-c",
			"-C",
			"-f",
			"-u",
			"-t",
			"--delete",
			"--move",
			"--copy",
			"--force",
			"--track",
			"--set-upstream-to",
			"--unset-upstream",
			"--edit-description",
		]),
		tag: listOnly("tag", [
			"-d",
			"-a",
			"-s",
			"-u",
			"-f",
			"-m",
			"-F",
			"-e",
			"--delete",
			"--annotate",
			"--sign",
			"--force",
		]),
		remote: (a) =>
			a.length === 0 || a[0] === "-v" || a[0] === "show" || a[0] === "get-url"
				? undefined
				: "only git remote, -v, show and get-url are allowed",
		stash: (a) => (a[0] === "list" || a[0] === "show" ? undefined : "only git stash list and show are allowed"),
		worktree: (a) => (a[0] === "list" ? undefined : "only git worktree list is allowed"),
		notes: (a) => (a[0] === "list" || a[0] === "show" ? undefined : "only git notes list and show are allowed"),
		submodule: (a) => (a.length === 0 || a[0] === "status" ? undefined : "only git submodule status is allowed"),
		reflog: (a) =>
			a.length === 0 || a[0] === "show" || a[0]!.startsWith("-") ? undefined : `git reflog ${a[0]} is not read-only`,
		config: (a) => {
			const reads = [
				"--get",
				"--get-all",
				"--get-regexp",
				"--list",
				"-l",
				"--get-urlmatch",
				"--show-origin",
				"--show-scope",
			];
			if (a[0] === "get" || a[0] === "list") return undefined;
			return a.some((x) => reads.includes(x)) &&
				!a.some((x) =>
					[
						"--add",
						"--unset",
						"--unset-all",
						"--replace-all",
						"--edit",
						"-e",
						"--rename-section",
						"--remove-section",
					].includes(x),
				)
				? undefined
				: "only git config --get and --list are allowed";
		},
	})(rest);
};

const gh: ArgRule = (args) => {
	const read: Record<string, string[]> = {
		pr: ["view", "list", "diff", "checks", "status"],
		issue: ["view", "list", "status"],
		run: ["view", "list"],
		workflow: ["view", "list"],
		repo: ["view"],
		release: ["view", "list"],
		search: ["repos", "issues", "prs", "code", "commits"],
	};
	const [group, sub] = args;
	if (group === "status" || group === "--version") return undefined;
	if (group === "api") {
		const bad = args.find(
			(a, i) =>
				["-f", "-F", "--field", "--raw-field", "--input"].includes(a.split("=")[0]!) ||
				((a === "-X" || a === "--method") && !/^(GET|HEAD)$/i.test(args[i + 1] ?? "")) ||
				(a.startsWith("--method=") && !/^--method=(GET|HEAD)$/i.test(a)),
		);
		return bad ? `gh api ${bad} is not read-only; only GET requests are allowed` : undefined;
	}
	if (!group || !read[group]) return `gh ${group ?? ""} is not read-only`.trim();
	if (!sub || !read[group]!.includes(sub)) return `gh ${group} ${sub ?? ""} is not read-only`.trim();
	return undefined;
};

const npmRead = [
	"ls",
	"list",
	"view",
	"info",
	"show",
	"outdated",
	"why",
	"explain",
	"search",
	"root",
	"prefix",
	"query",
];
const npm = subcommands("npm", [...npmRead, "audit", "config"], {
	audit: (a) => (a.includes("fix") ? "npm audit fix is not read-only" : undefined),
	config: (a) =>
		a[0] === "get" || a[0] === "list" || a[0] === "ls" ? undefined : "only npm config get and list are allowed",
});

const curl = denyFlags(
	"curl",
	[
		"--output",
		"--output-dir",
		"--remote-name",
		"--remote-name-all",
		"--upload-file",
		"--data",
		"--data-raw",
		"--data-binary",
		"--data-urlencode",
		"--json",
		"--form",
		"--form-string",
		"--request",
		"--cookie-jar",
		"--dump-header",
		"--config",
		"--trace",
		"--trace-ascii",
		"--stderr",
		"--libcurl",
	],
	"oOTdFXcDK",
);

/**
 * Commands allowed in architect mode, with checks for the ones that can also write.
 * Anything not listed is refused. Interactive tools (less, vim, top) are left out because the agent cannot use them.
 */
export const COMMANDS: Record<string, ArgRule> = {
	cat: ANY,
	head: ANY,
	tail: ANY,
	ls: ANY,
	pwd: ANY,
	cd: ANY,
	echo: ANY,
	printf: ANY,
	wc: ANY,
	grep: ANY,
	egrep: ANY,
	fgrep: ANY,
	diff: ANY,
	cmp: ANY,
	comm: ANY,
	file: ANY,
	stat: ANY,
	du: ANY,
	df: ANY,
	which: ANY,
	whereis: ANY,
	type: ANY,
	whoami: ANY,
	id: ANY,
	uname: ANY,
	hostname: ANY,
	date: ANY,
	basename: ANY,
	dirname: ANY,
	realpath: ANY,
	readlink: ANY,
	cut: ANY,
	tr: ANY,
	nl: ANY,
	column: ANY,
	paste: ANY,
	rev: ANY,
	fold: ANY,
	strings: ANY,
	od: ANY,
	hexdump: ANY,
	true: ANY,
	false: ANY,
	test: ANY,
	"[": ANY,
	ps: ANY,
	uptime: ANY,
	printenv: ANY,
	seq: ANY,
	jq: ANY,
	tokei: ANY,
	cloc: ANY,
	md5sum: ANY,
	md5: ANY,
	shasum: ANY,
	sha1sum: ANY,
	sha256sum: ANY,
	cksum: ANY,
	bat: ANY,
	eza: ANY,
	exa: ANY,
	ag: ANY,
	ack: ANY,
	env: (args) => (args.length === 0 ? undefined : "env with arguments runs a command; run the command directly"),
	sort: denyFlags("sort", ["--output", "--compress-program"], "o"),
	uniq: (args) => (positional(args).length <= 1 ? undefined : "uniq with an output file is not read-only"),
	tree: denyFlags("tree", [], "o"),
	xxd: denyFlags("xxd", ["--revert"], "r"),
	yq: denyFlags("yq", ["--inplace"], "i"),
	rg: denyFlags("rg", ["--pre"]),
	fd: denyFlags("fd", ["--exec", "--exec-batch"], "xX"),
	find,
	sed,
	awk,
	gawk: awk,
	git,
	gh,
	npm,
	pnpm: subcommands("pnpm", ["ls", "list", "why", "outdated", "view", "info"]),
	yarn: subcommands("yarn", ["list", "info", "why", "outdated"]),
	node: versionOnly("node"),
	python: versionOnly("python"),
	python3: versionOnly("python3"),
	deno: versionOnly("deno"),
	bun: versionOnly("bun"),
	ruby: versionOnly("ruby"),
	go: subcommands("go", ["version", "list", "doc", "env"], {
		env: (a) => (a.some((x) => x === "-w" || x === "-u") ? "go env -w changes settings" : undefined),
	}),
	cargo: subcommands("cargo", ["tree", "metadata", "search"]),
	curl,
};

/** Variables a command may set for itself. Others (PATH, LD_PRELOAD, GIT_PAGER, …) could run other programs. */
const SAFE_ENV = /^(NO_COLOR|FORCE_COLOR|CLICOLOR|TERM|LANG|LC_[A-Z]+|COLUMNS|LINES|TZ)$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

function checkRedirect(redirect: Redirect): string | undefined {
	const { op, target } = redirect;
	if (op === "<" || op === "<<<") return undefined;
	if (op === ">&" || op === "<&")
		return /^(\d+|-)$/.test(target.value) ? undefined : `"${op}${target.value}" writes a file`;
	return target.literal && target.value === "/dev/null"
		? undefined
		: `redirecting output to "${target.value}" writes a file`;
}

function checkCommand(command: SimpleCommand): string | undefined {
	for (const redirect of command.redirects) {
		const reason = checkRedirect(redirect);
		if (reason) return reason;
	}
	const words: Word[] = [...command.words];
	while (words.length && words[0]!.literal && ASSIGNMENT.test(words[0]!.value)) {
		const name = ASSIGNMENT.exec(words[0]!.value)![1]!;
		if (!SAFE_ENV.test(name)) return `setting ${name} is not allowed`;
		words.shift();
	}
	const [name, ...args] = words;
	if (!name) return undefined;
	if (!name.literal) return "the command name must be written out, not taken from a variable";
	if (name.value.includes("/")) return `run commands by name, not by path (${name.value})`;
	const rule = COMMANDS[name.value];
	if (!rule) return `${name.value} is not a read-only command`;
	return rule(args.map((a) => a.value));
}

export type CommandCheck = { ok: true } | { ok: false; reason: string };

/** Whether a bash command line only reads. Every command in a list or pipeline must pass. */
export function checkReadOnly(commandLine: string): CommandCheck {
	const parsed = parseCommandLine(commandLine);
	if (!parsed.ok) return parsed;
	for (const command of parsed.commands) {
		const reason = checkCommand(command);
		if (reason) return { ok: false, reason };
	}
	return { ok: true };
}

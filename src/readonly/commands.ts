import { git } from "./git.ts";
import { options, type ArgRule, type OptionSpec } from "./options.ts";
import { parseCommandLine, type Redirect, type SimpleCommand, type Word } from "./shell.ts";

/** For commands that have no option that writes or runs something: any argument is fine, globs too. */
const ANY: ArgRule = () => undefined;

const values = (args: readonly Word[]) => args.map((a) => a.value);

function noGlobs(command: string, args: readonly Word[]): string | undefined {
	const glob = args.find((a) => a.glob);
	return glob ? `quote "${glob.value}": ${command} does not take file name patterns` : undefined;
}

/** Only the exact version flags. `python -v` or `bun version` would run code. */
function versionOnly(command: string, flags: string[]): ArgRule {
	return (args) =>
		args.length === 1 && flags.includes(args[0]!.value) && !args[0]!.glob
			? undefined
			: `only "${command} ${flags[0]}" is allowed`;
}

/** sed scripts that only print, delete or substitute: `10,20p`, `/re/p`, `s/a/b/g`, `5q`. No `w`, `e` or `r`. */
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

/**
 * sed without `-i`, `-f` and `-l` (a value in GNU sed, a flag in BSD sed, so the script could hide behind it).
 * The scripts are the `-e` values, or else the first argument.
 */
const sed = options(
	"sed",
	{
		flags: "nErsuz",
		values: "e",
		long: ["quiet", "silent", "regexp-extended", "separate", "unbuffered", "null-data", "posix", "debug", "sandbox"],
		longValues: ["expression"],
		globs: true,
	},
	(p) => {
		const scripts = p.options.filter((o) => o.name === "-e" || o.name === "--expression").map((o) => o.value ?? "");
		if (!scripts.length) {
			const first = p.positional[0];
			if (!first) return "sed needs a script";
			if (first.glob) return `quote the sed script "${first.value}"`;
			scripts.push(first.value);
		}
		return scripts.every(safeSedScript)
			? undefined
			: "only sed scripts that print, delete or substitute (p, d, q, s///g) are allowed; use read or grep instead";
	},
);

/**
 * awk with the program inline. The program may not mention anything that runs a command or opens a file:
 * `system`, `getline`, `close`, `fflush`, `|`, `>`, and `@` (gawk's indirect calls and `@load`).
 */
const AWK_UNSAFE = /system|getline|close|fflush|[@|>]|\\\n/;
const awk: ArgRule = (args) => {
	if (args.length === 1 && args[0]!.value === "--version") return undefined;
	return options("awk", { values: "Fv", globs: true }, (p) => {
		const program = p.positional[0];
		if (!program) return "awk needs a program; awk -f is not allowed";
		if (program.glob) return `quote the awk program "${program.value}"`;
		if (AWK_UNSAFE.test(program.value))
			return "awk programs may not use system, getline, close, fflush, @, | or > (compare with < instead of >)";
		return undefined;
	})(args);
};

const FIND_VALUE = new Set([
	"-name",
	"-iname",
	"-path",
	"-ipath",
	"-wholename",
	"-iwholename",
	"-regex",
	"-iregex",
	"-type",
	"-xtype",
	"-size",
	"-mtime",
	"-mmin",
	"-atime",
	"-amin",
	"-ctime",
	"-cmin",
	"-newer",
	"-anewer",
	"-cnewer",
	"-perm",
	"-user",
	"-group",
	"-uid",
	"-gid",
	"-links",
	"-inum",
	"-samefile",
	"-lname",
	"-ilname",
	"-used",
	"-fstype",
	"-maxdepth",
	"-mindepth",
	"-regextype",
	"-printf",
]);
const FIND_FLAG = new Set([
	"-nouser",
	"-nogroup",
	"-empty",
	"-readable",
	"-writable",
	"-executable",
	"-true",
	"-false",
	"-print",
	"-print0",
	"-ls",
	"-prune",
	"-quit",
	"-depth",
	"-d",
	"-follow",
	"-xdev",
	"-mount",
	"-noleaf",
	"-daystart",
	"-ignore_readdir_race",
	"-noignore_readdir_race",
	"-warn",
	"-nowarn",
	"-not",
	"-a",
	"-and",
	"-o",
	"-or",
	"-L",
	"-H",
	"-P",
	"-E",
	"-x",
	"-s",
]);
const FIND_RUNS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** find with allowlisted tests and actions. `-exec`, `-ok`, `-delete` and `-fprint` are not on the list. */
const find: ArgRule = (args) => {
	for (let i = 0; i < args.length; i++) {
		const { value, glob } = args[i]!;
		if (!value.startsWith("-") || value === "-") {
			if (glob && !/^[A-Za-z0-9._/]/.test(value)) return `quote "${value}": find does not take that pattern there`;
			continue;
		}
		if (glob) return `quote "${value}"`;
		if (FIND_RUNS.has(value)) return `find ${value} runs commands; list the files with find, then read them`;
		if (value === "-delete") return "find -delete deletes files";
		if (FIND_FLAG.has(value)) continue;
		if (FIND_VALUE.has(value) || /^-newer[aBcmt][aBcmt]$/.test(value)) {
			const next = args[++i];
			if (!next) return `find ${value} needs a value`;
			if (next.glob) return `quote the pattern after find ${value}: '${next.value}'`;
			if (/^-[^\d]/.test(next.value)) return `find ${value} cannot take "${next.value}" as its value`;
			continue;
		}
		if (["-fprint", "-fprint0", "-fprintf", "-fls"].includes(value))
			return `find ${value} writes a file; use -print or -printf`;
		return `find ${value} is not allowed in architect mode`;
	}
	return undefined;
};

/** sort without `-o`, `-T` and `--compress-program`. */
const sort = options("sort", {
	flags: "bdfghiMnrRsuVcCzm",
	values: "ktS",
	long: [
		"ignore-leading-blanks",
		"dictionary-order",
		"ignore-case",
		"general-numeric-sort",
		"human-numeric-sort",
		"ignore-nonprinting",
		"month-sort",
		"numeric-sort",
		"reverse",
		"random-sort",
		"stable",
		"unique",
		"version-sort",
		"merge",
		"zero-terminated",
		"debug",
	],
	longValues: ["key", "field-separator", "sort", "buffer-size", "parallel"],
	longOptional: ["check"],
	globs: true,
});

/** uniq reads one file; a second file is its output. */
const uniq = options(
	"uniq",
	{
		flags: "cdDuiz",
		values: "fsw",
		long: ["count", "repeated", "unique", "ignore-case", "zero-terminated"],
		longValues: ["skip-fields", "skip-chars", "check-chars"],
		longOptional: ["all-repeated", "group"],
	},
	(p) => (p.positional.length <= 1 ? undefined : "uniq with a second file writes to it; pipe the output instead"),
);

/** tree without `-o` (output file) and `-R` (writes 00Tree.html files). */
const tree = options("tree", {
	flags: "adlfiqNQpugshDFvtcrUCnxJX",
	values: "LPI",
	long: ["du", "si", "dirsfirst", "noreport", "gitignore", "prune", "matchdirs", "ignore-case"],
	longValues: ["charset", "filelimit", "sort"],
	globs: true,
});

/** ripgrep without `--pre`, `--hostname-bin` and `--search-zip`, which run programs. */
const rg = options("rg", {
	flags: "isSwxvlcnNoquUFPHIaL0",
	values: "ABCegtTmMjrEd",
	long: [
		"hidden",
		"no-ignore",
		"no-ignore-vcs",
		"no-ignore-dot",
		"no-ignore-parent",
		"ignore-case",
		"smart-case",
		"case-sensitive",
		"word-regexp",
		"line-regexp",
		"invert-match",
		"files",
		"files-with-matches",
		"files-without-match",
		"count",
		"count-matches",
		"line-number",
		"no-line-number",
		"only-matching",
		"quiet",
		"fixed-strings",
		"multiline",
		"multiline-dotall",
		"pcre2",
		"json",
		"vimgrep",
		"heading",
		"no-heading",
		"column",
		"with-filename",
		"no-filename",
		"follow",
		"text",
		"null",
		"stats",
		"type-list",
		"trim",
		"passthru",
		"unrestricted",
		"binary",
		"no-messages",
		"max-columns-preview",
		"one-file-system",
		"no-config",
		"byte-offset",
		"invert-match",
		"no-unicode",
		"crlf",
	],
	longValues: [
		"sort",
		"sortr",
		"type",
		"type-not",
		"glob",
		"iglob",
		"max-count",
		"max-depth",
		"max-filesize",
		"context",
		"after-context",
		"before-context",
		"regexp",
		"replace",
		"color",
		"colors",
		"max-columns",
		"context-separator",
		"threads",
		"encoding",
		"engine",
		"path-separator",
	],
	globs: true,
});

/** fd without `-x`/`--exec`, `-X`/`--exec-batch` and `-l` (which runs ls). */
const fd = options("fd", {
	flags: "HIusigFapL01q",
	values: "etEdcjS",
	long: [
		"hidden",
		"no-ignore",
		"no-ignore-vcs",
		"unrestricted",
		"case-sensitive",
		"ignore-case",
		"glob",
		"regex",
		"fixed-strings",
		"absolute-path",
		"full-path",
		"follow",
		"print0",
		"quiet",
		"show-errors",
		"prune",
		"one-file-system",
	],
	longValues: [
		"type",
		"extension",
		"exclude",
		"max-depth",
		"min-depth",
		"exact-depth",
		"max-results",
		"size",
		"changed-within",
		"changed-before",
		"owner",
		"color",
		"search-path",
		"base-directory",
	],
	longOptional: ["strip-cwd-prefix"],
	globs: true,
});

/** bat without `--pager`; paging only as `--paging=never` or `-P`. */
const bat = options("bat", {
	flags: "npAPfu",
	values: "lrHm",
	long: ["number", "plain", "show-all", "force-colorization", "diff", "list-languages", "list-themes", "unbuffered"],
	longValues: [
		"language",
		"line-range",
		"highlight-line",
		"style",
		"color",
		"theme",
		"decorations",
		"wrap",
		"tabs",
		"file-name",
		"terminal-width",
		"map-syntax",
		"diff-context",
		"paging",
	],
	globs: true,
	check: (option, value) =>
		option === "--paging" && value !== "never" ? "only bat --paging=never is allowed; use -P" : undefined,
});

/** yq (Go or Python) without `-i` (in place), `-s` (split into files) and expression files. */
const yq = options("yq", {
	flags: "reMCPNy",
	values: "op",
	long: ["yaml-output"],
	longValues: ["output-format", "input-format"],
});

/** file without `-C` (compiles a magic file) and `-p` (resets access times). */
const file = options("file", {
	flags: "bikLhNnrs0E",
	values: "efFP",
	long: [
		"brief",
		"mime",
		"mime-type",
		"mime-encoding",
		"extension",
		"keep-going",
		"dereference",
		"no-dereference",
		"no-pad",
		"raw",
		"special-files",
		"print0",
	],
	longValues: ["exclude", "files-from", "separator", "parameter"],
	globs: true,
});

/** date that shows a date, not one that sets the clock. The only argument is a +FORMAT. */
const date = options(
	"date",
	{
		flags: "uR",
		values: "rv",
		attached: "I",
		long: ["utc", "universal", "rfc-email", "debug"],
		longValues: ["date", "reference", "rfc-3339"],
		longOptional: ["iso-8601"],
	},
	(p) =>
		p.positional.every((a) => a.value.startsWith("+")) && p.positional.length <= 1
			? undefined
			: "date only takes a +FORMAT; other arguments set the clock",
);

/** hostname that prints the name, not one that sets it. */
const hostname = options(
	"hostname",
	{
		flags: "sfdiIAa",
		long: ["short", "fqdn", "long", "domain", "ip-address", "all-ip-addresses", "all-fqdns", "alias"],
	},
	(p) => (p.positional.length ? "hostname with a name sets it" : undefined),
);

/** bash's printf -v and test -v evaluate array subscripts, which can run commands. */
const printf: ArgRule = (args) => {
	const first = args[0]?.value;
	if (first !== undefined && first.startsWith("-") && first !== "--")
		return "printf options are not allowed (printf -v can run code); put -- before a format that starts with -";
	return noGlobs("printf", args);
};

function test(command: string): ArgRule {
	return (args) => {
		const bad = args.find((a) => a.value === "-v" || a.value === "-R");
		if (bad) return `${command} ${bad.value} is not allowed: it can run code through array subscripts`;
		return noGlobs(command, args);
	};
}

/** curl GET and HEAD requests over http(s), printing to stdout. No uploads, output files or config files. */
const curl = options(
	"curl",
	{
		flags: "sSLIivfk46#G",
		values: "HAemuxrbX",
		long: [
			"silent",
			"show-error",
			"location",
			"head",
			"include",
			"verbose",
			"fail",
			"fail-with-body",
			"insecure",
			"compressed",
			"http1.1",
			"http2",
			"ipv4",
			"ipv6",
			"globoff",
			"no-progress-meter",
			"progress-bar",
			"get",
		],
		longValues: [
			"header",
			"user-agent",
			"referer",
			"max-time",
			"connect-timeout",
			"retry",
			"retry-delay",
			"max-redirs",
			"user",
			"proxy",
			"range",
			"cookie",
			"url",
			"request",
		],
		check: (option, value) => {
			if ((option === "-X" || option === "--request") && !/^(GET|HEAD)$/i.test(value ?? ""))
				return `curl ${option} ${value ?? ""} is not read-only; only GET and HEAD are allowed`;
			if (option === "--url" && !/^https?:\/\//i.test(value ?? ""))
				return "curl only fetches http:// and https:// URLs";
			return undefined;
		},
	},
	(p) => {
		if (p.positional.some((a) => !/^https?:\/\//i.test(a.value)))
			return "curl only fetches http:// and https:// URLs; write the scheme out";
		return undefined;
	},
);

/** gh read commands. `--web` and `-w` open a browser and `--watch` keeps running, so they are left out. */
const GH_READ: Record<string, string[]> = {
	pr: ["view", "list", "diff", "checks", "status"],
	issue: ["view", "list", "status"],
	run: ["view", "list"],
	workflow: ["view", "list"],
	repo: ["view"],
	release: ["view", "list"],
	search: ["repos", "issues", "prs", "code", "commits"],
};

const GH: OptionSpec = {
	flags: "vyd",
	values: "qtRLsAlBHSjuebrOo",
	long: [
		"comments",
		"name-only",
		"patch",
		"log",
		"log-failed",
		"verbose",
		"exit-status",
		"all",
		"yaml",
		"draft",
		"required",
		"exclude-drafts",
		"exclude-pre-releases",
		"conflict-status",
		"archived",
		"include-forks",
	],
	longValues: [
		"json",
		"jq",
		"template",
		"repo",
		"limit",
		"state",
		"assignee",
		"author",
		"label",
		"base",
		"head",
		"search",
		"color",
		"branch",
		"job",
		"attempt",
		"workflow",
		"user",
		"event",
		"status",
		"commit",
		"created",
		"updated",
		"ref",
		"order",
		"sort",
		"owner",
		"language",
		"filename",
		"extension",
		"match",
		"visibility",
		"topic",
		"milestone",
		"mention",
		"org",
		"exclude",
	],
};

/** gh api GET requests: no fields, no input, no method but GET, and only Accept or API version headers. */
const ghApi = options(
	"gh api",
	{
		flags: "i",
		values: "HXqtp",
		long: ["include", "paginate", "slurp", "silent", "verbose"],
		longValues: ["header", "method", "jq", "template", "hostname", "cache", "preview"],
		check: (option, value) => {
			if ((option === "-X" || option === "--method") && !/^(GET|HEAD)$/i.test(value ?? ""))
				return `gh api ${option} ${value ?? ""} is not read-only; only GET requests are allowed`;
			if ((option === "-H" || option === "--header") && !/^\s*(accept|x-github-api-version)\s*:/i.test(value ?? ""))
				return "gh api only takes Accept and X-GitHub-Api-Version headers";
			return undefined;
		},
	},
	(p) => {
		if (p.positional.length !== 1) return "gh api takes one endpoint";
		if (p.positional[0]!.value === "graphql") return "gh api graphql sends a POST; use gh pr view or gh issue view";
		return undefined;
	},
);

const gh: ArgRule = (args) => {
	const [group, sub] = values(args);
	if (group === "--version" || group === "version") return args.length === 1 ? undefined : "use gh --version alone";
	if (group === "status") return options("gh status", GH)(args.slice(1));
	if (group === "api") return ghApi(args.slice(1));
	if (!group || !GH_READ[group]) return `gh ${group ?? ""} is not read-only`.trim();
	if (!sub || !GH_READ[group]!.includes(sub)) return `gh ${group} ${sub ?? ""} is not read-only`.trim();
	return options(`gh ${group} ${sub}`, GH)(args.slice(2));
};

/**
 * npm subcommands that read. Only long options from a short list: npm accepts any config key as an option
 * (`--cache`, `--logs-dir` and others write files), and abbreviations of them.
 */
const NPM: OptionSpec = {
	long: [
		"json",
		"all",
		"long",
		"parseable",
		"global",
		"prod",
		"production",
		"dev",
		"workspaces",
		"include-workspace-root",
	],
	longValues: ["depth", "omit", "include", "workspace", "audit-level"],
};
const NPM_READ = ["ls", "list", "view", "info", "show", "outdated", "why", "explain", "root", "prefix", "query"];
const npm: ArgRule = (args) => {
	const [subcommand] = values(args);
	if (subcommand === "--version" || subcommand === "-v")
		return args.length === 1 ? undefined : "use npm --version alone";
	if (subcommand === "audit")
		return options("npm audit", NPM, (p) =>
			p.positional.length ? `npm audit ${p.positional[0]!.value} is not allowed; use npm audit alone` : undefined,
		)(args.slice(1));
	if (subcommand === "config") {
		const [, action] = values(args);
		if (action !== "get" && action !== "list" && action !== "ls")
			return "only npm config get and npm config list are allowed";
		return options(`npm config ${action}`, NPM)(args.slice(2));
	}
	if (!subcommand || !NPM_READ.includes(subcommand))
		return `npm ${subcommand ?? ""} is not read-only; use one of: ${NPM_READ.join(", ")}`;
	return options(`npm ${subcommand}`, NPM)(args.slice(1));
};

/** go version, env, list and doc. Go flags take one or two dashes. `go env -w` and build flags like `-toolexec` are left out. */
const GO: Record<string, OptionSpec> = {
	version: { long: ["m", "v", "json"], singleDash: true },
	env: { long: ["json", "changed"], singleDash: true },
	list: {
		long: ["m", "e", "deps", "test", "find", "versions", "u", "retracted"],
		longValues: ["f", "tags"],
		longOptional: ["json"],
		singleDash: true,
	},
	doc: { long: ["all", "c", "cmd", "short", "src", "u"], singleDash: true },
};
const go: ArgRule = (args) => {
	const [subcommand] = values(args);
	const spec = subcommand === undefined ? undefined : GO[subcommand];
	if (!spec) return `go ${subcommand ?? ""} is not read-only; use go version, env, list or doc`;
	return options(`go ${subcommand}`, spec)(args.slice(1));
};

/**
 * Commands allowed in architect mode, with checks for the ones that have options that write or run something.
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
	wc: ANY,
	grep: ANY,
	egrep: ANY,
	fgrep: ANY,
	diff: ANY,
	cmp: ANY,
	comm: ANY,
	stat: ANY,
	du: ANY,
	df: ANY,
	which: ANY,
	whereis: ANY,
	type: ANY,
	whoami: ANY,
	id: ANY,
	uname: ANY,
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
	ps: ANY,
	uptime: ANY,
	printenv: ANY,
	seq: ANY,
	jq: ANY,
	tokei: ANY,
	md5sum: ANY,
	md5: ANY,
	shasum: ANY,
	sha1sum: ANY,
	sha256sum: ANY,
	cksum: ANY,
	eza: ANY,
	exa: ANY,
	printf,
	test: test("test"),
	"[": test("["),
	env: (args) => (args.length === 0 ? undefined : "env with arguments runs a command; run the command directly"),
	date,
	hostname,
	file,
	sort,
	uniq,
	tree,
	rg,
	fd,
	bat,
	yq,
	find,
	sed,
	awk,
	gawk: awk,
	git,
	gh,
	npm,
	go,
	node: versionOnly("node", ["--version", "-v"]),
	python: versionOnly("python", ["--version", "-V"]),
	python3: versionOnly("python3", ["--version", "-V"]),
	deno: versionOnly("deno", ["--version", "-V"]),
	bun: versionOnly("bun", ["--version"]),
	ruby: versionOnly("ruby", ["--version"]),
	curl,
};

/** Hints for commands people often reach for. */
const INSTEAD: Record<string, string> = {
	xxd: "use od or hexdump",
	cloc: "use tokei",
	ag: "use rg or grep",
	ack: "use rg or grep",
	less: "use the read tool",
	more: "use the read tool",
	touch: "describe the change in the design instead",
	rm: "describe the change in the design instead",
	mv: "describe the change in the design instead",
	cp: "describe the change in the design instead",
	mkdir: "describe the change in the design instead",
};

function checkRedirect(redirect: Redirect): string | undefined {
	const { op, target } = redirect;
	if (/^\/dev\/(tcp|udp)\//.test(target.value)) return "network redirections (/dev/tcp) are not allowed";
	if (op === "<" || op === "<<<") return undefined;
	if (op === ">&" || op === "<&")
		return /^(\d+|-)$/.test(target.value) ? undefined : `"${op}${target.value}" writes a file`;
	return target.value === "/dev/null" && !target.glob
		? undefined
		: `redirecting output to "${target.value}" writes a file; only /dev/null is allowed`;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

function checkCommand(command: SimpleCommand): string | undefined {
	for (const redirect of command.redirects) {
		const reason = checkRedirect(redirect);
		if (reason) return reason;
	}
	const [name, ...args] = command.words;
	if (!name) return undefined;
	if (ASSIGNMENT.test(name.value))
		return `variable assignments (${name.value.split("=")[0]}=…) are not allowed; run the command without them`;
	if (name.glob) return `the command name must be written out ("${name.value}")`;
	if (name.value === "{" || name.value === "}") return "command groups ({ …; }) are not allowed";
	if (name.value.includes("/")) return `run commands by name, not by path (${name.value})`;
	const rule = Object.hasOwn(COMMANDS, name.value) ? COMMANDS[name.value] : undefined;
	if (!rule) {
		const hint = INSTEAD[name.value];
		return `${name.value} is not a read-only command${hint ? `; ${hint}` : ""}`;
	}
	return rule(args);
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

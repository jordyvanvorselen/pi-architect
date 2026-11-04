import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkReadOnly } from "../src/readonly/commands.ts";
import { blockReason } from "../src/readonly/index.ts";
import { parseCommandLine } from "../src/readonly/shell.ts";
import { ATTACKS, LEGIT } from "./readonly-cases.ts";

function allowed(command: string) {
	const result = checkReadOnly(command);
	assert.deepEqual(result, { ok: true }, `expected allowed: ${command}`);
}

function blocked(command: string, reason?: RegExp) {
	const result = checkReadOnly(command);
	assert.equal(result.ok, false, `expected blocked: ${command}`);
	if (reason && !result.ok) assert.match(result.reason, reason, command);
}

describe("shell lexer", () => {
	it("splits lists and pipelines into simple commands", () => {
		const parsed = parseCommandLine("ls -la && grep -r foo src | head -5; wc -l x || true\npwd");
		assert.ok(parsed.ok);
		assert.deepEqual(
			parsed.commands.map((c) => c.words.map((w) => w.value).join(" ")),
			["ls -la", "grep -r foo src", "head -5", "wc -l x", "true", "pwd"],
		);
	});

	it("removes quotes and escapes, and marks unquoted globs", () => {
		const parsed = parseCommandLine(`grep "a b" 'c $d' e\\ f '*.ts' *.md a\\*b x[1] [`);
		assert.ok(parsed.ok);
		const words = parsed.commands[0]!.words;
		assert.deepEqual(
			words.map((w) => w.value),
			["grep", "a b", "c $d", "e f", "*.ts", "*.md", "a*b", "x[1]", "["],
		);
		assert.deepEqual(
			words.map((w) => w.glob),
			[false, false, false, false, false, true, false, true, false],
		);
	});

	it("reads redirections with their file descriptor", () => {
		const parsed = parseCommandLine("grep x y 2>/dev/null 2>&1 < input");
		assert.ok(parsed.ok);
		assert.deepEqual(
			parsed.commands[0]!.redirects.map((r) => [r.op, r.target.value]),
			[
				[">", "/dev/null"],
				[">&", "1"],
				["<", "input"],
			],
		);
		assert.deepEqual(
			parsed.commands[0]!.words.map((w) => w.value),
			["grep", "x", "y"],
		);
	});

	it("skips comments and line continuations", () => {
		const parsed = parseCommandLine("ls \\\n -la # rm -rf /");
		assert.ok(parsed.ok);
		assert.deepEqual(
			parsed.commands[0]!.words.map((w) => w.value),
			["ls", "-la"],
		);
	});

	it("refuses unclosed quotes and a trailing backslash", () => {
		assert.equal(parseCommandLine("echo 'x").ok, false);
		assert.equal(parseCommandLine('echo "x').ok, false);
		assert.equal(parseCommandLine("echo x\\").ok, false);
	});

	it("refuses a redirection without a target", () => {
		assert.deepEqual(parseCommandLine("ls >"), { ok: false, reason: '">" has no target' });
	});

	it("refuses every word bash would expand", () => {
		for (const [command, reason] of [
			["echo $HOME", /\$ is not allowed/],
			['echo "$HOME"', /\$ is not allowed/],
			['echo "${x}"', /\$ is not allowed/],
			["echo $'\\x41'", /\$ is not allowed/],
			['echo $"x"', /\$ is not allowed/],
			["echo $((1+1))", /\$ is not allowed/],
			["echo x$", /\$ is not allowed/],
			["echo `id`", /command substitution/],
			['echo "`id`"', /command substitution/],
			["echo {a,b}", /brace expansion/],
			["echo {1..3}", /brace expansion/],
			["echo x{a,'b'}y", /brace expansion/],
			["echo ~root", /only ~ and ~\/path/],
			["echo ~+", /only ~ and ~\/path/],
			["echo ~-/x", /only ~ and ~\/path/],
			["echo a=~/x", /after = or :/],
			["echo --opt=~/x", /after = or :/],
			["echo PATH:~/bin", /after = or :/],
			["cat <(ls)", /process substitution/],
			["ls >(cat)", /process substitution/],
			["echo a\rb", /control characters/],
		] as const)
			assert.match((parseCommandLine(command) as { reason: string }).reason, reason, command);
	});

	it("keeps quoted or escaped specials as text", () => {
		for (const command of [
			"echo '$HOME'",
			'echo "\\$HOME"',
			"echo \\$HOME",
			"echo '{a,b}' \\{a,b}",
			"echo '~root' \\~root",
			"echo HEAD@{1} a{b}c",
			"echo ~ ~/x",
		])
			assert.ok(parseCommandLine(command).ok, command);
	});
});

describe("regressions from the review", () => {
	it("refuses arguments that bash expands before the check could see them", () => {
		blocked("find . {-exec,} sh -c 'touch x' \\;", /brace expansion/);
		blocked("find . -exec$U sh -c 'touch x' \\;", /\$ is not allowed/);
		blocked("awk $'BEGIN{sy\\x73tem(\"touch x\")}'", /\$ is not allowed/);
		blocked("sed -{i,} s/a/b/ f", /brace expansion/);
		blocked("git log --out{put,}=x", /brace expansion/);
		blocked("curl -$O https://x", /\$ is not allowed/);
		blocked("sort -${o} x f", /\$ is not allowed/);
	});

	it("refuses printf -v, test -v and assignments", () => {
		blocked("printf -v 'a[$(touch x)]' x", /printf/);
		blocked("printf -va x", /printf/);
		blocked("test -v 'a[$(touch x)]'", /test -v/);
		blocked("[ -v 'a[$(touch x)]' ]", /\[ -v/);
		blocked("test -R x", /test -R/);
		blocked("TZ=UTC", /assignments/);
		blocked("TZ=UTC date", /assignments/);
		blocked("NO_COLOR=1 git log", /assignments/);
		blocked("a[0]=1", /assignments/);
		blocked("X+=1 ls", /assignments/);
	});

	it("refuses git ls-remote and gh api methods in any spelling", () => {
		blocked("git ls-remote --upload-pack='sh -c touch' .", /git ls-remote/);
		blocked("gh api -XDELETE repos/o/r", /only GET/);
		blocked("gh api -X DELETE repos/o/r", /only GET/);
		blocked("gh api --method=PATCH repos/o/r", /only GET/);
		blocked("gh api --method PUT repos/o/r", /only GET/);
		blocked("gh api -iXPOST repos/o/r", /only GET/);
		blocked("gh api -H 'X-HTTP-Method-Override: DELETE' repos/o/r", /headers/);
		blocked("gh api graphql", /graphql/);
	});

	it("refuses allowed commands that still write files or run programs", () => {
		blocked("xxd in out", /xxd is not a read-only command/);
		blocked("cloc --report-file=x .", /cloc/);
		blocked("yq -s '.a' x.yaml", /yq -s/);
		blocked("file -C -m magic", /file -C/);
		blocked("curl --etag-save e https://x", /curl --etag-save/);
		blocked("curl --hsts h https://x", /curl --hsts/);
		blocked("curl --alt-svc a https://x", /curl --alt-svc/);
		blocked("bat --pager='sh -c x' f", /bat --pager/);
		blocked("bat --paging=always f", /paging=never/);
		blocked("ag --pager=sh x", /ag is not a read-only command/);
		blocked("ack --pager=sh x", /ack is not a read-only command/);
		blocked("rg --hostname-bin=sh x", /rg --hostname-bin/);
		blocked("rg --pre=sh x", /rg --pre/);
		blocked("awk -l x '{print}'", /awk -l/);
		blocked("awk -E x.awk", /awk -E/);
		blocked("go env -w GOFLAGS=-x", /go env -w/);
		blocked("go env -u GOFLAGS", /go env -u/);
	});

	it("refuses GNU long-option abbreviations", () => {
		blocked("sort --outp=f x", /sort --outp/);
		blocked("sed --in-pl s/a/b/ f", /sed --in-pl/);
		blocked("git log --outp=x", /git log --outp/);
		blocked("git diff --out=x", /git diff --out/);
		blocked("git log --onel", /write the full option name: git log --oneline/);
		blocked("rg --hostn=sh x", /rg --hostn/);
		blocked("npm ls --glo", /write the full option name/);
	});
});

describe("attacks", () => {
	for (const [command, reason] of ATTACKS) it(`blocks ${JSON.stringify(command)}`, () => blocked(command, reason));
});

describe("legitimate commands", () => {
	for (const command of LEGIT) it(`allows ${JSON.stringify(command)}`, () => allowed(command));
});

describe("reasons", () => {
	it("explains a blocked bash command", () => {
		assert.match(
			blockReason("bash", { command: "ls && rm x" })!,
			/^Blocked: rm is not a read-only command; describe the change in the design instead\. Only read-only commands run in architect mode/,
		);
	});

	it("points to the allowed alternative", () => {
		blocked("less f", /use the read tool/);
		blocked("xxd f", /use od or hexdump/);
		blocked("git log --onel", /git log --oneline/);
		blocked("git reflog main", /use git reflog show main/);
		blocked("sort *", /quote "\*"/);
		blocked("awk '$1 > 5' f", /compare with < instead of >/);
	});

	it("blocks edit, write and powershell with a hint", () => {
		assert.match(blockReason("edit", {})!, /edit is off in architect mode.*\/architect build/);
		assert.match(blockReason("write", {})!, /write is off/);
		assert.match(blockReason("powershell", {})!, /powershell is off/);
	});

	it("passes other tools and read-only bash", () => {
		assert.equal(blockReason("read", { path: "x" }), undefined);
		assert.equal(blockReason("bash", { command: "ls" }), undefined);
	});
});

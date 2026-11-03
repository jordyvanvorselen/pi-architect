import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkReadOnly } from "../src/readonly/commands.ts";
import { blockReason } from "../src/readonly/index.ts";
import { parseCommandLine } from "../src/readonly/shell.ts";

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

	it("removes quotes and escapes, and tracks expansions", () => {
		const parsed = parseCommandLine(`grep "a b" 'c $d' e\\ f "$HOME" $'g\\'h'`);
		assert.ok(parsed.ok);
		const words = parsed.commands[0]!.words;
		assert.deepEqual(
			words.map((w) => w.value),
			["grep", "a b", "c $d", "e f", "$HOME", "g\\'h"],
		);
		assert.deepEqual(
			words.map((w) => w.literal),
			[true, true, true, true, false, true],
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
		assert.equal(parseCommandLine("echo $'x").ok, false);
		assert.equal(parseCommandLine("echo x\\").ok, false);
	});

	it("refuses a redirection without a target", () => {
		assert.deepEqual(parseCommandLine("ls >"), { ok: false, reason: '">" has no target' });
	});
});

describe("read-only commands", () => {
	it("allows plain reading and searching", () => {
		for (const command of [
			"ls -la src",
			"cat package.json",
			"head -50 src/index.ts",
			"grep -rn 'TODO' src",
			"rg -n --type ts appendEntry",
			"find . -name '*.ts' -not -path './node_modules/*'",
			"wc -l src/*.ts",
			"tree -L 2",
			"jq .scripts package.json",
			"cd src && ls",
			"echo hello",
			"sort -u names.txt | uniq -c",
			"fd -e ts",
			"diff a.ts b.ts",
		])
			allowed(command);
	});

	it("allows read-only git", () => {
		for (const command of [
			"git status",
			"git log --oneline -20",
			"git diff HEAD~1 -- src",
			"git show HEAD:package.json",
			"git -C ../other log",
			"git --no-pager log -p",
			"git blame src/index.ts",
			"git branch -a",
			"git branch --list 'feat/*'",
			"git branch --contains abc123",
			"git tag",
			"git tag -l 'v*'",
			"git remote -v",
			"git stash list",
			"git config --get user.name",
			"git ls-files",
			"git --version",
			"git reflog",
		])
			allowed(command);
	});

	it("blocks git that writes", () => {
		for (const command of [
			"git commit -m x",
			"git push",
			"git checkout main",
			"git reset --hard",
			"git add .",
			"git branch new-branch",
			"git branch -D old",
			"git tag v1.0",
			"git tag -d v1.0",
			"git stash",
			"git config user.name x",
			"git -c core.pager=evil log",
			"git diff --output=x.patch",
			"git grep -O foo",
			"git remote add origin x",
			"git reflog expire",
			"git",
		])
			blocked(command);
	});

	it("blocks commands that are not on the allowlist", () => {
		blocked("rm -rf src", /rm is not a read-only command/);
		blocked("mv a b", /mv is not a read-only command/);
		blocked("touch x");
		blocked("npx prettier --write .");
		blocked("xargs rm");
		blocked("sudo ls");
		blocked("bash -c 'rm x'");
		blocked("vim file");
	});

	it("blocks writes hidden behind chaining", () => {
		blocked("ls && rm x", /rm/);
		blocked("ls; rm x", /rm/);
		blocked("ls || rm x", /rm/);
		blocked("cat x | tee y", /tee/);
		blocked("ls\nrm x", /rm/);
	});

	it("blocks output redirection to files but allows /dev/null and descriptor copies", () => {
		blocked("echo x > file", /writes a file/);
		blocked("echo x >> file", /writes a file/);
		blocked("ls >| file");
		blocked("ls &> out.log");
		blocked("ls 2> err.log");
		blocked("ls >&out.log");
		blocked('echo x > "$FILE"');
		allowed("ls 2>/dev/null");
		allowed("grep x y >/dev/null 2>&1");
		allowed("wc -l < file.txt");
		allowed("grep x <<< 'text'");
	});

	it("blocks subshells, substitutions, here-documents and background jobs", () => {
		blocked("(rm x)", /subshells/);
		blocked("echo $(rm x)", /command substitution/);
		blocked('echo "$(rm x)"', /command substitution/);
		blocked("echo `rm x`", /command substitution/);
		blocked('echo "`rm x`"', /command substitution/);
		blocked("diff <(ls a) <(ls b)", /process substitution/);
		blocked("cat > x <<EOF\nhi\nEOF", /here-documents/);
		blocked("sleep 10 &", /background/);
		blocked("{ rm x; }");
		blocked("ls <> file");
		blocked("case x in a) ;; esac");
	});

	it("allows quoted operators as plain text", () => {
		allowed("grep '&& rm' notes.md");
		allowed('echo "a > b" "(c)"');
		allowed("grep \\> file");
	});

	it("blocks commands named by variable or path, and unsafe variables", () => {
		blocked("$CMD x", /written out/);
		blocked("./script.sh", /by name/);
		blocked("/bin/rm x", /by name/);
		blocked("PATH=/tmp ls", /setting PATH/);
		blocked("GIT_PAGER=evil git log", /setting GIT_PAGER/);
		allowed("NO_COLOR=1 git log");
		blocked("PATH=/tmp; ls", /setting PATH/);
		allowed("TZ=UTC");
	});

	it("checks the arguments of commands that can also write", () => {
		blocked("find . -delete", /find -delete/);
		blocked("find . -name x -exec rm {} \\;", /find -exec/);
		blocked("sort -o out.txt in.txt", /sort -o/);
		blocked("sort --output=out.txt in.txt", /sort --output/);
		blocked("uniq in.txt out.txt", /uniq/);
		blocked("tree -o out.txt");
		blocked("fd -x rm");
		blocked("rg --pre ./evil foo");
		blocked("xxd -r dump bin");
		blocked("yq -i '.a = 1' x.yaml");
		blocked("env rm x", /env/);
		allowed("env");
	});

	it("allows sed only for printing, deleting and substituting", () => {
		allowed("sed -n '10,40p' src/index.ts");
		allowed("sed -n '/start/,/end/p' file");
		allowed("sed 's/foo/bar/g' file");
		allowed("sed -e 's|a|b|' -e '5q' file");
		allowed("sed --expression=1d file");
		allowed("cat x | sed 's/a\\/b/c/2'");
		blocked("sed -i 's/a/b/' file", /sed -i/);
		blocked("sed -ni 's/a/b/p' file", /sed -i/);
		blocked("sed --in-place 's/a/b/' file", /sed -i/);
		blocked("sed 's/a/b/w out' file", /only sed scripts/);
		blocked("sed 'w out' file");
		blocked("sed '1e rm x' file");
		blocked("sed -f script.sed file", /sed -f/);
		blocked("sed", /needs a script/);
		blocked("sed 's/a/b' file");
		blocked("sed 's a b ' file");
	});

	it("allows awk without system, getline, pipes or output redirection", () => {
		allowed("awk '{print $1}' file");
		blocked("awk 'BEGIN{system(\"rm x\")}'", /awk/);
		blocked("awk '{print > \"out\"}' file", /awk/);
		blocked("awk '{print | \"sh\"}' file");
		blocked("awk -f prog.awk file");
		blocked("gawk -i inplace '{print}' file");
	});

	it("allows read-only package manager, runtime and gh commands", () => {
		for (const command of [
			"npm ls",
			"npm view typebox version",
			"npm audit",
			"npm config get registry",
			"npm --version",
			"pnpm why x",
			"node --version",
			"python3 -V",
			"go list ./...",
			"go env GOPATH",
			"cargo tree",
			"gh pr view 42",
			"gh run list",
			"gh api repos/a/b/pulls",
			"gh api -X GET repos/a/b",
			"gh status",
		])
			allowed(command);
		for (const command of [
			"npm install",
			"npm audit fix",
			"npm config set x y",
			"npm",
			'node -e \'require("fs").rmSync("x")\'',
			"python script.py",
			"go env -w GOPATH=x",
			"go build",
			"gh pr merge 42",
			"gh pr",
			"gh api -X POST repos/a/b/issues",
			"gh api --method=DELETE repos/a/b",
			"gh api repos/a/b/issues -f title=x",
			"gh browse",
		])
			blocked(command);
	});

	it("allows curl reads but not uploads or file output", () => {
		allowed("curl -sSL https://example.com");
		allowed("curl -H 'Accept: json' https://example.com");
		blocked("curl -o page.html https://example.com", /curl -o/);
		blocked("curl -sSLO https://example.com/x", /curl -O/);
		blocked("curl --data x=1 https://example.com", /curl --data/);
		blocked("curl -X POST https://example.com");
	});
});

describe("blockReason", () => {
	it("blocks edit, write and powershell with a hint", () => {
		assert.match(blockReason("edit", {})!, /edit is off in architect mode.*\/mode build/);
		assert.match(blockReason("write", {})!, /write is off/);
		assert.match(blockReason("powershell", {})!, /powershell is off/);
	});

	it("passes other tools and read-only bash", () => {
		assert.equal(blockReason("read", { path: "x" }), undefined);
		assert.equal(blockReason("bash", { command: "ls" }), undefined);
		assert.equal(blockReason("bash", {}), undefined);
	});

	it("explains a blocked bash command", () => {
		assert.match(
			blockReason("bash", { command: "ls && rm x" })!,
			/^Blocked: rm is not a read-only command\. Only read-only commands run in architect mode/,
		);
	});
});

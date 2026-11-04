/**
 * Runs every command the checker allows in a real bash, in a temp dir with a canary file, nasty file names
 * and a fake PATH whose sh, touch, rm and friends only log that they ran. Proves that nothing ran or wrote.
 * Skipped when bash is missing.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { checkReadOnly } from "../src/readonly/commands.ts";
import { ATTACKS } from "./readonly-cases.ts";

const which = spawnSync("/bin/sh", ["-c", "command -v bash"], { encoding: "utf8" });
const BASH = which.status === 0 ? which.stdout.trim() : "";

/** Programs an attack would want to run. Each one is a logger in the fake PATH. */
const LOGGED = [
	"sh",
	"bash",
	"dash",
	"zsh",
	"touch",
	"rm",
	"mv",
	"cp",
	"tee",
	"dd",
	"ln",
	"chmod",
	"truncate",
	"install",
	"mkdir",
	"python",
	"python3",
	"perl",
	"ruby",
	"node",
	"npx",
	"xargs",
	"curl",
	"wget",
	"nc",
	"open",
	"xdg-open",
	"less",
	"more",
];

/** File names that turn into options, code or substitutions if a glob or an unchecked word reaches them. */
const NASTY = [
	"-v",
	"-i",
	"-o",
	"-e",
	"-exec",
	"-delete",
	"--help",
	"--output=pwned",
	"--in-place",
	"--pre=sh",
	"a[$(touch pwned)]",
	"x;touch pwned",
	'BEGIN{system("touch pwned")}',
	"w pwned",
];

/** Commands that get past the checker but try to sneak something through bash, or run on the nasty names. */
const TRICKY = [
	"echo '$(touch pwned)'",
	"echo '`touch pwned`'",
	"echo \\$\\(touch pwned\\)",
	"echo 'a && touch pwned' a\\;touch\\ pwned",
	"echo '{-exec,}' \\{a,b} HEAD@{1} a{b}c ~/x",
	"grep -r 'touch pwned' .",
	"cat 'x;touch pwned'",
	"printf -- '-v' 'a[$(touch pwned)]'",
	"printf '%s\\n' 'a[$(touch pwned)]'",
	"printf '%d' 'a[$(touch pwned)]'",
	"test 'a[$(touch pwned)]' -eq 1",
	"[ 'a[$(touch pwned)]' -lt 1 ]",
	"type 'a[$(touch pwned)]'",
	"cd 'a[$(touch pwned)]'",
	"cat <<< '$(touch pwned)'",
	"grep x <<< '`touch pwned`'",
	"ls # ; touch pwned",
	"echo x 2>/dev/null >/dev/null",
	"ls *",
	"ls -la ./*",
	"cat *",
	"wc -l *",
	"head -1 *",
	"grep -l x *",
	"echo *",
	"file ./*",
	"sort ./*",
	"find ./* -maxdepth 0",
	"find . -name 'pwned' -print",
	"sed -n 1p ./*",
	"sed -n 's/a/b/p' f",
	"awk '{print $1}' f",
	"awk 'NR == 1' ./*",
	"awk 'BEGIN{x = \"touch pwned\"; print x}'",
	"uniq f",
	"git log --oneline -1",
	"git log --format='%h $(touch pwned)' -1",
	"git status -s",
	"git grep -n 'touch pwned'",
	"git show HEAD:f",
	"git ls-files ./*",
	"git diff --stat HEAD",
];

function snapshot(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const path = join(d, entry.name);
			out.push(relative(dir, path));
			if (entry.isDirectory()) walk(path);
		}
	};
	walk(dir);
	return out.sort();
}

describe("allowed commands in a real bash", { skip: BASH ? false : "bash is not installed" }, () => {
	let root: string;
	let work: string;
	let log: string;
	let env: NodeJS.ProcessEnv;

	before(() => {
		root = mkdtempSync(join(tmpdir(), "pi-architect-bash-"));
		work = join(root, "work");
		const bin = join(root, "bin");
		log = join(root, "ran.log");
		mkdirSync(work);
		mkdirSync(bin);
		mkdirSync(join(root, "home"));
		for (const name of LOGGED) {
			const path = join(bin, name);
			writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "$PWNED_LOG"\n`);
			chmodSync(path, 0o755);
		}
		writeFileSync(join(work, "canary"), "canary\n");
		writeFileSync(join(work, "f"), "a b\nx y\n");
		for (const name of NASTY) writeFileSync(join(work, name), "x\n");
		env = {
			PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			HOME: join(root, "home"),
			PWNED_LOG: log,
			LANG: "C",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		};
		// Set up a repository with the real git, before the loggers are in the way.
		const setup = "git init -q && git add -A && git commit -qm init";
		spawnSync(BASH, ["-c", setup], { cwd: work, env: { ...env, PATH: process.env.PATH }, stdio: "ignore" });
	});

	after(() => rmSync(root, { recursive: true, force: true }));

	it("runs nothing and writes nothing", () => {
		const before = snapshot(work);
		const candidates = [...ATTACKS.map(([command]) => command), ...TRICKY];
		const ran = candidates.filter((command) => checkReadOnly(command).ok);
		assert.ok(ran.length >= TRICKY.length, "the checker should allow the tricky but harmless commands");
		for (const command of ran) {
			spawnSync(BASH, ["-c", command], { cwd: work, env, stdio: "ignore", timeout: 5000 });
			assert.ok(!existsSync(log), `${command} ran: ${existsSync(log) ? readFileSync(log, "utf8") : ""}`);
		}
		assert.equal(readFileSync(join(work, "canary"), "utf8"), "canary\n");
		assert.deepEqual(snapshot(work), before);
		assert.ok(!existsSync(join(work, "pwned")));
	});

	it("would notice a command that runs", () => {
		spawnSync(BASH, ["-c", "sh -c 'touch pwned'"], { cwd: work, env, stdio: "ignore", timeout: 5000 });
		assert.match(readFileSync(log, "utf8"), /^sh -c touch pwned/);
		rmSync(log);
	});
});

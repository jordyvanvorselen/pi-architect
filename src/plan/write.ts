import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Where plan files go, relative to the session's cwd, unless the user configures another directory. */
export const DEFAULT_PLAN_DIR = "docs/plans";

/** Gives up after this many taken names, rather than loop forever on a strange file system. */
const MAX_TRIES = 100;

const isExists = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";

/**
 * Write a new plan file in `dir` as `<slug>.md`, or `<slug>-2.md`, `<slug>-3.md` and so on when the name
 * is taken. Never overwrites a file: each attempt creates the file exclusively, so a file that appears
 * between two attempts is safe too. Creates `dir` when needed. Returns the absolute path.
 *
 * This is the only file pi-architect writes. It goes through Node directly, not through the edit or write
 * tools, so the read-only guard of architect mode stays as strict as before.
 */
export async function writePlan(dir: string, slug: string, content: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	for (let n = 1; n <= MAX_TRIES; n++) {
		const path = join(dir, `${slug}${n === 1 ? "" : `-${n}`}.md`);
		try {
			await writeFile(path, content, { encoding: "utf8", flag: "wx" });
			return resolve(path);
		} catch (error) {
			if (!isExists(error)) throw error;
		}
	}
	throw new Error(`${MAX_TRIES} plan files named ${slug} already exist in ${dir}.`);
}

/** The path to store and show: relative to `cwd` when the file is inside it, absolute otherwise. */
export function displayPath(cwd: string, file: string): string {
	const rel = relative(cwd, file);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : resolve(file);
}

/** Absolute path of a stored plan path. */
export const planFile = (cwd: string, path: string) => resolve(cwd, path);

/** The file's text, or undefined when it cannot be read. */
export async function readPlan(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return undefined;
	}
}

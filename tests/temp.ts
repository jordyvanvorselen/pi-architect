import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/** Every directory `tempDir` made in this test file, removed once its tests are done. */
const made: string[] = [];

after(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory in the system temp dir, removed after the tests of the file that made it. */
export function tempDir(prefix = "pi-architect-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

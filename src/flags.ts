// `pi --architect` and `pi --architect-plan-dir <dir>`.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PLAN_DIR } from "./plan/write.ts";

export const FLAG = "architect";
/** `--architect-plan-dir <dir>`: where plan files go, relative to the cwd. */
export const PLAN_DIR_FLAG = "architect-plan-dir";

/** The column `pi --help` starts flag descriptions at: it pads `  --name <value>` to this width. */
export const HELP_COLUMN = 30;

/**
 * A flag description that `pi --help` keeps apart from the flag. Pi pads the flag to 30 columns without a
 * space after it, so a flag of 28 columns or more would run into its description.
 */
export function flagHelp(name: string, type: "boolean" | "string", text: string): string {
	const flag = `  --${name}${type === "string" ? " <value>" : ""}`;
	return flag.length >= HELP_COLUMN - 1 ? ` ${text}` : text;
}

export function registerFlags(pi: ExtensionAPI): void {
	pi.registerFlag(FLAG, {
		description: flagHelp(FLAG, "boolean", "Start in architect mode: design a feature before building it"),
		type: "boolean",
	});
	pi.registerFlag(PLAN_DIR_FLAG, {
		description: flagHelp(
			PLAN_DIR_FLAG,
			"string",
			`Where approved plans are written, relative to the working directory (default ${DEFAULT_PLAN_DIR})`,
		),
		type: "string",
	});
}

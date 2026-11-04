/**
 * Allowlisted options. A command only gets the options listed in its spec; anything else is refused.
 * Long options must be written in full: GNU tools accept any unambiguous prefix (`--outp` for `--output`),
 * and only the tool knows its full option list, so a prefix could name an option that is not listed here.
 */
import type { Word } from "./shell.ts";

export interface OptionSpec {
	/** Short options without a value, e.g. `"nrv"`. They can be bundled: `-nr`. */
	flags?: string;
	/** Short options with a value, attached (`-n5`) or as the next word (`-n 5`). */
	values?: string;
	/** Short options with an optional value, which is only ever attached (`-M50%`). */
	attached?: string;
	/** Long options without a value. */
	long?: readonly string[];
	/** Long options with a value: `--name=value` or `--name value`. */
	longValues?: readonly string[];
	/** Long options with an optional value, only as `--name=value`. */
	longOptional?: readonly string[];
	/** Accepts `-NUM`, as in `head -20` or `git log -5`. */
	numeric?: boolean;
	/** Options are single words with one or two dashes, as in Go (`-json`, `-f=x`). No bundles. */
	singleDash?: boolean;
	/** Positional arguments are only paths or patterns, so they may be globs. */
	globs?: boolean;
	/** Checks an option's value. Returns why it is not allowed. */
	check?: (option: string, value: string | undefined) => string | undefined;
}

export interface ParsedOption {
	/** `-x` or `--name`. */
	name: string;
	value?: string;
}

export interface ParsedArgs {
	options: ParsedOption[];
	positional: Word[];
}

export type ParseOutcome = { ok: true; parsed: ParsedArgs } | { ok: false; reason: string };

class Refused extends Error {}

/** A glob in a positional argument is only safe when every file name it can match is a plain argument. */
const SAFE_GLOB_START = /^[A-Za-z0-9._/~]/;

/** A value given as the next word may not look like an option: a tool that reads the option differently would run it. */
const OPTION_LIKE = /^-[^\d]/;

export function parseArgs(command: string, spec: OptionSpec, args: readonly Word[]): ParseOutcome {
	const options: ParsedOption[] = [];
	const positional: Word[] = [];
	const longs = [...(spec.long ?? []), ...(spec.longValues ?? []), ...(spec.longOptional ?? [])];
	const fail = (reason: string): never => {
		throw new Refused(reason);
	};

	const take = (name: string, value: string | undefined) => {
		const reason = spec.check?.(name, value);
		if (reason) fail(reason);
		options.push(value === undefined ? { name } : { name, value });
	};

	const nextValue = (i: number, name: string): string => {
		const word = args[i];
		if (!word) return fail(`${command} ${name} needs a value`);
		if (word.glob) return fail(`quote the value of ${command} ${name} ("${word.value}")`);
		if (OPTION_LIKE.test(word.value)) return fail(`${command} ${name} cannot take "${word.value}" as its value`);
		return word.value;
	};

	const unknownLong = (name: string): never => {
		const full = longs.find((l) => l.startsWith(name));
		return fail(
			full
				? `write the full option name: ${command} --${full}`
				: `${command} --${name} is not allowed in architect mode`,
		);
	};

	const parseLong = (body: string, i: number, dashes: string): number => {
		const eq = body.indexOf("=");
		const name = eq === -1 ? body : body.slice(0, eq);
		const value = eq === -1 ? undefined : body.slice(eq + 1);
		const shown = `${dashes}${name}`;
		if (spec.long?.includes(name)) {
			if (value !== undefined && !spec.singleDash) fail(`${command} ${shown} takes no value`);
			take(shown, value);
			return i;
		}
		if (spec.longOptional?.includes(name)) {
			take(shown, value);
			return i;
		}
		if (spec.longValues?.includes(name)) {
			if (value !== undefined) take(shown, value);
			else take(shown, nextValue(++i, shown));
			return i;
		}
		if (spec.singleDash) {
			const full = longs.find((l) => l.startsWith(name));
			return fail(
				full ? `write the full flag name: ${command} -${full}` : `${command} ${shown} is not allowed in architect mode`,
			);
		}
		return unknownLong(name);
	};

	const parseShort = (arg: string, i: number): number => {
		if (spec.numeric && /^-\d+$/.test(arg)) {
			take(arg, undefined);
			return i;
		}
		for (let k = 1; k < arg.length; k++) {
			const ch = arg[k]!;
			const name = `-${ch}`;
			if (spec.flags?.includes(ch)) take(name, undefined);
			else if (spec.attached?.includes(ch)) {
				take(name, k + 1 < arg.length ? arg.slice(k + 1) : undefined);
				return i;
			} else if (spec.values?.includes(ch)) {
				if (k + 1 < arg.length) take(name, arg.slice(k + 1));
				else take(name, nextValue(++i, name));
				return i;
			} else fail(`${command} ${name} is not allowed in architect mode`);
		}
		return i;
	};

	try {
		let rest = false;
		for (let i = 0; i < args.length; i++) {
			const word = args[i]!;
			const arg = word.value;
			if (rest || arg === "-" || !arg.startsWith("-")) {
				if (word.glob && !(spec.globs && SAFE_GLOB_START.test(arg)))
					fail(`quote "${arg}": ${command} does not take file name patterns there`);
				positional.push(word);
				continue;
			}
			if (word.glob) fail(`quote "${arg}"`);
			if (arg === "--") {
				rest = true;
				continue;
			}
			if (spec.singleDash) i = parseLong(arg.replace(/^--?/, ""), i, "-");
			else if (arg.startsWith("--")) i = parseLong(arg.slice(2), i, "--");
			else i = parseShort(arg, i);
		}
	} catch (error) {
		if (error instanceof Refused) return { ok: false, reason: error.message };
		throw error;
	}
	return { ok: true, parsed: { options, positional } };
}

/** Checks the arguments of one command. Returns why it is not read-only, or undefined when it is. */
export type ArgRule = (args: readonly Word[]) => string | undefined;

/** A rule from an option spec, with an optional check on the parsed result. */
export function options(command: string, spec: OptionSpec, then?: (parsed: ParsedArgs) => string | undefined): ArgRule {
	return (args) => {
		const outcome = parseArgs(command, spec, args);
		if (!outcome.ok) return outcome.reason;
		return then?.(outcome.parsed);
	};
}

/** Whether the parsed options include one of `names`. */
export const has = (parsed: ParsedArgs, ...names: string[]) => parsed.options.some((o) => names.includes(o.name));

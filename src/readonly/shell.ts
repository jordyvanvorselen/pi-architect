/**
 * A small, strict shell lexer for the read-only check. It does not run or expand anything.
 * It splits a command line into simple commands and their redirections, and refuses the constructs
 * that could hide a write: command and process substitution, subshells, here-documents and background jobs.
 * When in doubt it fails closed with a reason the model can act on.
 */

export interface Word {
	/** The word with quotes and escapes removed. */
	value: string;
	/** False when the word contains an unquoted or double-quoted `$` expansion, so its value is not known. */
	literal: boolean;
}

export interface Redirect {
	/** `>`, `>>`, `>|`, `&>`, `&>>`, `>&`, `<`, `<&`, `<<<`. */
	op: string;
	target: Word;
}

export interface SimpleCommand {
	words: Word[];
	redirects: Redirect[];
}

export type ParseResult = { ok: true; commands: SimpleCommand[] } | { ok: false; reason: string };

const CONTROL = new Set(["&&", "||", ";", "|", "|&", "\n"]);

type Token = { kind: "word"; word: Word } | { kind: "control"; op: string } | { kind: "redirect"; op: string };

class Refusal extends Error {}

function lex(input: string): Token[] {
	const tokens: Token[] = [];
	let value = "";
	let literal = true;
	let started = false;
	let i = 0;

	const flush = () => {
		if (started) tokens.push({ kind: "word", word: { value, literal } });
		value = "";
		literal = true;
		started = false;
	};

	while (i < input.length) {
		const c = input[i]!;
		const next = input[i + 1];

		if (c === " " || c === "\t") {
			flush();
			i++;
			continue;
		}
		if (c === "\n" || c === "\r") {
			flush();
			tokens.push({ kind: "control", op: "\n" });
			i++;
			continue;
		}
		if (c === "#" && !started) {
			while (i < input.length && input[i] !== "\n") i++;
			continue;
		}
		if (c === "\\") {
			if (next === undefined) throw new Refusal("the command ends with a backslash");
			i += 2;
			if (next === "\n") continue;
			value += next;
			started = true;
			continue;
		}
		if (c === "'") {
			const end = input.indexOf("'", i + 1);
			if (end === -1) throw new Refusal("a single quote is not closed");
			value += input.slice(i + 1, end);
			started = true;
			i = end + 1;
			continue;
		}
		if (c === '"') {
			i++;
			started = true;
			for (;;) {
				if (i >= input.length) throw new Refusal("a double quote is not closed");
				const d = input[i]!;
				if (d === '"') break;
				if (d === "`" || (d === "$" && input[i + 1] === "(")) throw new Refusal("command substitution is not allowed");
				if (d === "$") literal = false;
				if (d === "\\" && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1]!)) {
					if (input[i + 1] !== "\n") value += input[i + 1];
					i += 2;
					continue;
				}
				value += d;
				i++;
			}
			i++;
			continue;
		}
		if (c === "`") throw new Refusal("command substitution is not allowed");
		if (c === "$") {
			if (next === "(") throw new Refusal("command substitution is not allowed");
			if (next === "'") {
				// ANSI-C quoting: $'...' with backslash escapes. The value is only used for allowlist checks.
				let j = i + 2;
				while (j < input.length && input[j] !== "'") j += input[j] === "\\" ? 2 : 1;
				if (j >= input.length) throw new Refusal("a single quote is not closed");
				value += input.slice(i + 2, j);
				started = true;
				i = j + 1;
				continue;
			}
			literal = false;
			value += c;
			started = true;
			i++;
			continue;
		}
		if (c === "(" || c === ")") throw new Refusal("subshells and command groups are not allowed");
		if (c === "&" || c === "|" || c === ";") {
			flush();
			const two = c + (next ?? "");
			if (two === "&&" || two === "||" || two === "|&") {
				tokens.push({ kind: "control", op: two });
				i += 2;
			} else if (two === "&>") {
				const op = input[i + 2] === ">" ? "&>>" : "&>";
				tokens.push({ kind: "redirect", op });
				i += op.length;
			} else if (two === ";;" || two === ";&") {
				throw new Refusal(`"${two}" is not allowed`);
			} else if (c === "&") {
				throw new Refusal("background jobs (&) are not allowed");
			} else {
				tokens.push({ kind: "control", op: c });
				i++;
			}
			continue;
		}
		if (c === "<" || c === ">") {
			// A number right before the operator is its file descriptor, as in 2>/dev/null.
			if (started && literal && /^\d+$/.test(value)) {
				value = "";
				started = false;
			} else flush();
			const rest = input.slice(i);
			const op = ["<<<", "<<-", "&>>", ">>", ">|", ">&", "<&", "<<", "<>", "<(", ">(", "<", ">"].find((o) =>
				rest.startsWith(o),
			)!;
			if (op === "<(" || op === ">(") throw new Refusal("process substitution is not allowed");
			if (op === "<<" || op === "<<-") throw new Refusal("here-documents are not allowed");
			if (op === "<>") throw new Refusal("opening a file for writing is not allowed");
			tokens.push({ kind: "redirect", op });
			i += op.length;
			continue;
		}
		value += c;
		started = true;
		i++;
	}
	flush();
	return tokens;
}

/** Split a command line into simple commands. Pipelines and lists become one entry per command. */
export function parseCommandLine(input: string): ParseResult {
	let tokens: Token[];
	try {
		tokens = lex(input);
	} catch (error) {
		if (error instanceof Refusal) return { ok: false, reason: error.message };
		throw error;
	}
	const commands: SimpleCommand[] = [];
	let current: SimpleCommand = { words: [], redirects: [] };
	const end = () => {
		if (current.words.length || current.redirects.length) commands.push(current);
		current = { words: [], redirects: [] };
	};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.kind === "control") {
			if (!CONTROL.has(token.op)) return { ok: false, reason: `"${token.op}" is not allowed` };
			end();
		} else if (token.kind === "redirect") {
			const target = tokens[i + 1];
			if (target?.kind !== "word") return { ok: false, reason: `"${token.op}" has no target` };
			current.redirects.push({ op: token.op, target: target.word });
			i++;
		} else current.words.push(token.word);
	}
	end();
	return { ok: true, commands };
}

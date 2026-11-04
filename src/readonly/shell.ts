/**
 * A small, strict shell lexer for the read-only check. It does not run or expand anything.
 * It splits a command line into simple commands and their redirections.
 *
 * Words must be literal: what the checker sees is what bash runs. So it refuses anything bash would expand
 * before running the command: `$` in any form (variables, `$(…)`, `$'…'`, `$"…"`), backticks, brace expansion,
 * `~user` and `~` after `=` or `:`, and process substitution. It also refuses subshells, here-documents and
 * background jobs. Globs are kept and marked, so each command decides where it accepts them.
 * When in doubt it fails closed with a reason the model can act on.
 */

export interface Word {
	/** The word with quotes and escapes removed. */
	value: string;
	/** True when the word has an unquoted `*`, `?` or `[…]`, so bash may replace it with file names. */
	glob: boolean;
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

type Token = { kind: "word"; word: Word } | { kind: "control"; op: string } | { kind: "redirect"; op: string };

class Refusal extends Error {}

const DOLLAR =
	"$ is not allowed: no variables, $(…), $'…' or $\"…\". Write the value out; put text with $ in single quotes";
const BACKTICK = "command substitution (`…`) is not allowed";

const REDIRECT_OPS = ["<<<", "<<-", "&>>", ">>", ">|", ">&", "<&", "<<", "<>", "<(", ">(", "<", ">"];

/** Builds a word and remembers which characters were unquoted, since only those can expand. */
class WordBuilder {
	value = "";
	bare: boolean[] = [];
	started = false;

	add(text: string, unquoted: boolean): void {
		for (let k = 0; k < text.length; k++) {
			this.value += text[k];
			this.bare.push(unquoted);
		}
		this.started = true;
	}

	/** The finished word. Refuses brace and tilde expansion, and marks globs. */
	finish(): Word {
		const { value, bare } = this;
		const unquoted = (i: number, ch: string) => value[i] === ch && bare[i] === true;
		let brace = false;
		let list = false;
		let glob = false;
		for (let i = 0; i < value.length; i++) {
			if (unquoted(i, "{")) brace = true;
			if (unquoted(i, ",") || (unquoted(i, ".") && unquoted(i + 1, "."))) list = true;
			if (unquoted(i, "*") || unquoted(i, "?")) glob = true;
			if (unquoted(i, "[") && value.indexOf("]", i + 1) !== -1) glob = true;
			if (unquoted(i, "~")) {
				const start = i === 0 && (value.length === 1 || value[1] === "/");
				if (i === 0 && !start) throw new Refusal(`"${value}": only ~ and ~/path are allowed; write the path out`);
				if (i > 0 && (value[i - 1] === "=" || value[i - 1] === ":"))
					throw new Refusal(`"${value}": ~ after = or : expands to a path; write the path out or quote the ~`);
			}
		}
		if (brace && list)
			throw new Refusal(`brace expansion is not allowed ("${value}"); write each word out or quote the braces`);
		return { value, glob };
	}
}

function lex(input: string): Token[] {
	// eslint-disable-next-line no-control-regex
	const control = /[\x00-\x08\x0b-\x1f\x7f]/.exec(input);
	if (control) throw new Refusal("control characters (like \\r) are not allowed; use plain spaces and newlines");
	const tokens: Token[] = [];
	let word = new WordBuilder();
	let i = 0;

	const flush = () => {
		if (word.started) tokens.push({ kind: "word", word: word.finish() });
		word = new WordBuilder();
	};

	while (i < input.length) {
		const c = input[i]!;
		const next = input[i + 1];

		if (c === " " || c === "\t") {
			flush();
			i++;
			continue;
		}
		if (c === "\n") {
			flush();
			tokens.push({ kind: "control", op: "\n" });
			i++;
			continue;
		}
		if (c === "#" && !word.started) {
			while (i < input.length && input[i] !== "\n") i++;
			continue;
		}
		if (c === "\\") {
			if (next === undefined) throw new Refusal("the command ends with a backslash");
			i += 2;
			if (next !== "\n") word.add(next, false);
			continue;
		}
		if (c === "'") {
			const end = input.indexOf("'", i + 1);
			if (end === -1) throw new Refusal("a single quote is not closed");
			word.add(input.slice(i + 1, end), false);
			i = end + 1;
			continue;
		}
		if (c === '"') {
			i++;
			let text = "";
			for (;;) {
				if (i >= input.length) throw new Refusal("a double quote is not closed");
				const d = input[i]!;
				if (d === '"') break;
				if (d === "`") throw new Refusal(BACKTICK);
				if (d === "$") throw new Refusal(DOLLAR);
				if (d === "\\" && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1]!)) {
					if (input[i + 1] !== "\n") text += input[i + 1];
					i += 2;
					continue;
				}
				text += d;
				i++;
			}
			word.add(text, false);
			i++;
			continue;
		}
		if (c === "`") throw new Refusal(BACKTICK);
		if (c === "$") throw new Refusal(DOLLAR);
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
			if (word.started && /^\d+$/.test(word.value) && word.bare.every(Boolean)) word = new WordBuilder();
			else if (word.started && word.value.endsWith("}"))
				throw new Refusal("named file descriptors ({name}>…) are not allowed");
			else flush();
			const rest = input.slice(i);
			const op = REDIRECT_OPS.find((o) => rest.startsWith(o))!;
			if (op === "<(" || op === ">(") throw new Refusal("process substitution is not allowed");
			if (op === "<<" || op === "<<-") throw new Refusal("here-documents are not allowed; use <<< 'text' instead");
			if (op === "<>") throw new Refusal("opening a file for writing is not allowed");
			tokens.push({ kind: "redirect", op });
			i += op.length;
			continue;
		}
		word.add(c, true);
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
		if (token.kind === "control") end();
		else if (token.kind === "redirect") {
			const target = tokens[i + 1];
			if (target?.kind !== "word") return { ok: false, reason: `"${token.op}" has no target` };
			current.redirects.push({ op: token.op, target: target.word });
			i++;
		} else current.words.push(token.word);
	}
	end();
	return { ok: true, commands };
}

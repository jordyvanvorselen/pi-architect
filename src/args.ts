/** What the words after `/architect` ask for. */
export type ArchitectArgs<S extends string> =
	| { kind: "none" }
	| { kind: "subcommand"; sub: S; rest: string }
	| { kind: "feature"; name: string }
	/** The first word starts with a subcommand but is not one, like `board6cSplit…` typed after autocomplete. */
	| { kind: "suspect"; sub: S; name: string };

/**
 * Read the words after `/architect`. The first word picks a subcommand when it is one. A first word that
 * only starts with one is suspect: it may be a feature like "Builder cleanup", or a subcommand with text
 * glued to it. Quotes name a feature as written, so `/architect "build pipeline"` is a feature.
 */
export function parseArchitectArgs<S extends string>(args: string, subcommands: readonly S[]): ArchitectArgs<S> {
	const text = args.trim();
	if (!text) return { kind: "none" };
	const quoted = /^"(.*)"$|^'(.*)'$|^“(.*)”$|^‘(.*)’$/.exec(text);
	if (quoted) {
		const name = quoted
			.slice(1)
			.find((g) => g !== undefined)!
			.trim();
		return name ? { kind: "feature", name } : { kind: "none" };
	}
	const [first = "", ...words] = text.split(/\s+/);
	const lower = first.toLowerCase();
	const exact = subcommands.find((s) => s === lower);
	if (exact) return { kind: "subcommand", sub: exact, rest: words.join(" ") };
	const prefix = subcommands.find((s) => lower.startsWith(s));
	if (prefix) return { kind: "suspect", sub: prefix, name: text };
	return { kind: "feature", name: text };
}

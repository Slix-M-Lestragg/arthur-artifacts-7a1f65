/**
 * Link rewriting for text handed to pi — FACTORED OUT of terminal-note.ts so
 * the prompt composer (Wave 2) can reuse it on submit/insert without pulling
 * in the note-payload builder. Pure over its inputs (the link resolver is
 * injected); no Obsidian dependency.
 *
 * Handles, for both plain links and `![[…]]` embeds:
 *   [[Target]]                 → absolute vault path
 *   [[Target|Alias]]           → absolute path (alias dropped)
 *   [[Target#Section]]         → absolute path + '#Section' preserved
 *   [[Target#Section|Alias]]   → absolute path + '#Section' (alias dropped)
 *   ![[image.png]]             → absolute path (the leading '!' is dropped —
 *                                pi gets a plain filesystem path either way)
 * Unresolved targets are left VERBATIM (the agent can still read the original
 * link text).
 */

/** A link resolver: given a wikilink target (no alias, no section), return its
 *  absolute vault path, or null when unresolved. Injected so the rewriter has
 *  no Obsidian dependency. */
export type LinkResolver = (target: string) => string | null;

/**
 * Rewrite `[[…]]` wikilinks and `![[…]]` embeds in `content` to absolute vault
 * paths. The resolver receives the bare target (alias and `#section` stripped);
 * the `#section` is re-appended to the resolved absolute path. Unresolved
 * links (resolver → null) stay verbatim.
 */
export function rewriteContextLinks(content: string, resolve: LinkResolver): string {
	// Match (!?)[[Target]], [[Target#Section]], [[Target|Alias]], [[Target#Section|Alias]].
	return content.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (whole, _bang: string, body: string) => {
		const [targetPart] = body.split("|");
		const target = (targetPart ?? "").trim();
		if (!target) return whole;
		const hashIdx = target.indexOf("#");
		const link = hashIdx >= 0 ? target.slice(0, hashIdx).trim() : target;
		const section = hashIdx >= 0 ? target.slice(hashIdx) : ""; // includes the '#'
		if (!link) return whole;
		const abs = resolve(link);
		if (!abs) return whole; // unresolved → leave the original link for the agent
		// Drop the alias (and the embed '!'); keep the section anchor.
		return abs + section;
	});
}

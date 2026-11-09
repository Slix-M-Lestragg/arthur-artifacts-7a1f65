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
 *   [[#Section]] / [[#^block]] → current-note absolute path + the anchor, when
 *                                currentNotePath is supplied; otherwise verbatim
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
 * the `#section` is re-appended to the resolved absolute path. Same-note
 * heading/block links use `currentNotePath` directly (already absolute), never
 * the resolver. Without that context they stay verbatim. Unresolved links
 * (resolver → null) stay verbatim.
 */
export function rewriteContextLinks(
	content: string,
	resolve: LinkResolver,
	currentNotePath?: string | null,
): string {
	// Match aliases, headings and block refs; the target may be empty for [[#…]].
	return content.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (whole, _bang: string, body: string) => {
		const [targetPart] = body.split("|");
		const target = (targetPart ?? "").trim();
		if (!target) return whole;
		const hashIdx = target.indexOf("#");
		const link = hashIdx >= 0 ? target.slice(0, hashIdx).trim() : target;
		const section = hashIdx >= 0 ? target.slice(hashIdx) : ""; // includes the '#'
		if (!link) {
			return section.length > 1 && currentNotePath ? currentNotePath + section : whole;
		}
		const abs = resolve(link);
		if (!abs) return whole; // unresolved → leave the original link for the agent
		// Drop the alias (and the embed '!'); keep the heading/block anchor.
		return abs + section;
	});
}

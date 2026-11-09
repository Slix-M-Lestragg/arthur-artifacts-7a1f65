/**
 * "Send active note / selection" payload builder — the pure half of the two
 * `send-active-note` / `send-selection` commands. The payload is written into
 * the ACTIVE terminal's pty (most-recently-focused terminal leaf) followed by
 * a carriage return, so the agent receives the note as a user prompt.
 *
 * Payload shape (reference main.ts sendToActiveTerminal, adapted):
 *   Here is the content of my note "<name>" (at <vaultAbsPath>):
 *
 *   ---
 *   <content with [[wikilinks]] rewritten to absolute paths>
 *   ---
 *   \r
 *
 * Wikilink rewrite: `[[Target]]`, `[[Target|Alias]]`, `[[Target#Section]]`,
 * `[[Target#Section|Alias]]` are rewritten to the TARGET note's absolute vault
 * path (the `#Section` is preserved; the `|Alias` is dropped). Unresolved
 * targets are left verbatim (the agent can still read the original link text).
 *
 * `buildNotePayload` + `rewriteWikilinks` are pure over their inputs (the link
 * resolver is injected) so smoke can assert the exact byte shape without a
 * vault. Production wires the resolver through `app.metadataCache.
 * getFirstLinkpathDest` + the vault base path (see main.ts).
 */

/** A link resolver: given a wikilink target (no alias, no section), return its
 *  absolute vault path, or null when unresolved. Injected so the pure builder
 *  has no Obsidian dependency. */
export type LinkResolver = (target: string) => string | null;

/**
 * Rewrite `[[…]]` wikilinks in `content` to absolute vault paths. Leaves
 * unresolved links + non-link text untouched. The resolver receives the bare
 * target (alias and `#section` stripped); the `#section` is re-appended to the
 * resolved absolute path.
 */
export function rewriteWikilinks(content: string, resolve: LinkResolver): string {
	// Match [[Target]], [[Target#Section]], [[Target|Alias]], [[Target#Section|Alias]].
	return content.replace(/\[\[([^\]\n]+)\]\]/g, (whole, body: string) => {
		const [targetPart, aliasPart] = body.split("|");
		const target = (targetPart ?? "").trim();
		if (!target) return whole;
		const hashIdx = target.indexOf("#");
		const link = hashIdx >= 0 ? target.slice(0, hashIdx).trim() : target;
		const section = hashIdx >= 0 ? target.slice(hashIdx) : ""; // includes the '#'
		if (!link) return whole;
		const abs = resolve(link);
		if (!abs) return whole; // unresolved → leave the original [[…]] for the agent
		// Drop the alias entirely; keep the section anchor.
		return abs + section;
	});
}

/**
 * Build the full payload string written into the pty. `absPath` is the note's
 * absolute vault path; `content` is its body (already wikilink-rewritten by
 * the caller, or pass `rewriteWikilinks` through `buildNotePayloadWith` for
 * the combined path). The trailing `\r` is the Enter the agent expects.
 */
export function buildNotePayload(name: string, absPath: string, content: string): string {
	return (
		`Here is the content of my note "${name}" (at ${absPath}):\n\n` +
		`---\n${content}\n---\r`
	);
}

/** Combined helper: rewrite wikilinks then assemble the payload. Pure. */
export function buildNotePayloadWith(
	name: string,
	absPath: string,
	content: string,
	resolve: LinkResolver,
): string {
	return buildNotePayload(name, absPath, rewriteWikilinks(content, resolve));
}

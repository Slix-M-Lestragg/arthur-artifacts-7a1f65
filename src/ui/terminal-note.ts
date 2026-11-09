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
 * The wikilink/embed rewrite itself moved to `link-rewrite.ts` (Wave 2 factored
 * it out so the prompt composer reuses it on submit/insert); this module keeps
 * the note-payload assembly and re-exports `rewriteWikilinks` for the send-note
 * commands and existing smoke assertions.
 *
 * `buildNotePayload` + `rewriteWikilinks` are pure over their inputs (the link
 * resolver is injected) so smoke can assert the exact byte shape without a
 * vault. Production wires the resolver through `app.metadataCache.
 * getFirstLinkpathDest` + the vault base path (see main.ts).
 */
import { rewriteContextLinks, type LinkResolver } from "./link-rewrite";

export type { LinkResolver };

/**
 * Rewrite `[[…]]` wikilinks and `![[…]]` embeds in `content` to absolute vault
 * paths (alias dropped, `#section` preserved, unresolved left verbatim).
 * Thin delegation to `rewriteContextLinks` — kept as the send-note command's
 * public name.
 */
export function rewriteWikilinks(content: string, resolve: LinkResolver): string {
	return rewriteContextLinks(content, resolve);
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

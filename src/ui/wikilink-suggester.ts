/**
 * Obsidian-notation completion for the pi composer. Note acceptance inserts a
 * literal `[[Note]]` and leaves the caret before `]]`; typing `#` there starts
 * the heading/block sub-completion pass. Send-time rewriting remains the only
 * conversion point.
 */
import type { CachedMetadata, TFile } from "obsidian";
import { fuzzyScore } from "./at-suggester";
import { TokenSuggester, type TokenSuggestion, type TokenSuggesterOptions } from "./token-suggester";

export interface WikilinkVault {
	getMarkdownFiles(): TFile[];
}

export interface WikilinkSuggesterOptions extends TokenSuggesterOptions {
	vault: WikilinkVault;
	metadataCache?: WikilinkMetadataCache;
}

export interface WikilinkMetadataCache {
	getFileCache(file: TFile): CachedMetadata | null;
}

/** Extract the unterminated `[[…` token ending at the caret. Newlines and the
 * first `]]` close it; unlike `@`, `[[` may begin in the middle of text. */
export function extractWikilinkPrefix(text: string): string | null {
	const start = text.lastIndexOf("[[");
	if (start < 0) return null;
	const query = text.slice(start + 2);
	return /[\r\n]/.test(query) || query.includes("]]") ? null : text.slice(start);
}

function notePathTarget(file: TFile): string {
	return file.path.replace(/\.md$/i, "");
}

function noteBasename(file: TFile): string {
	return file.basename || (file.path.split("/").pop() ?? file.path).replace(/\.md$/i, "");
}

/** Build note rows from the vault. A basename collision switches insertion to
 * the vault-relative path (without `.md`) so every accepted link is explicit. */
export function listWikilinkNoteSuggestions(files: TFile[], rawQuery: string): TokenSuggestion[] {
	const counts = new Map<string, number>();
	for (const file of files) {
		const key = noteBasename(file).toLowerCase();
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const scored: { file: TFile; basename: string; target: string; score: number }[] = [];
	for (const file of files) {
		const basename = noteBasename(file);
		const target = (counts.get(basename.toLowerCase()) ?? 0) > 1 ? notePathTarget(file) : basename;
		const byName = fuzzyScore(rawQuery, basename);
		const score = byName ?? fuzzyScore(rawQuery, notePathTarget(file));
		if (score === null) continue;
		scored.push({ file, basename, target, score });
	}
	scored.sort((a, b) => a.score - b.score
		|| a.basename.localeCompare(b.basename) || a.file.path.localeCompare(b.file.path));
	return scored.slice(0, 50).map(({ file, basename, target }) => {
		const slash = file.path.lastIndexOf("/");
		const folder = slash >= 0 ? file.path.slice(0, slash) : "Vault root";
		return {
			value: `[[${target}]]`,
			label: basename,
			description: target === basename ? folder : `${target} (duplicate basename)`,
			caretOffset: -2,
			consumeSuffix: "]]",
		};
	});
}

function findWikilinkNote(files: TFile[], rawTarget: string): TFile | null {
	const target = rawTarget.trim().toLowerCase();
	const byPath = files.find((file) => notePathTarget(file).toLowerCase() === target);
	if (byPath) return byPath;
	const byBasename = files.filter((file) => noteBasename(file).toLowerCase() === target);
	return byBasename.length === 1 ? byBasename[0] ?? null : null;
}

/** Metadata sub-completion. Null means "not available" and asks the caller to
 * retain note suggestions; an empty array means metadata existed but no row
 * matched the current heading/block filter. */
export function listWikilinkSubSuggestions(
	file: TFile,
	rawTarget: string,
	subQuery: string,
	cache: CachedMetadata | null | undefined,
): TokenSuggestion[] | null {
	const target = rawTarget.trim();
	if (subQuery.startsWith("^")) {
		const ids = [...new Set(Object.values(cache?.blocks ?? {})
			.map((block) => block.id).filter((id): id is string => !!id))];
		if (ids.length === 0) return null;
		const query = subQuery.slice(1);
		return ids.map((id) => ({ id, score: fuzzyScore(query, id) }))
			.filter((row): row is { id: string; score: number } => row.score !== null)
			.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
			.slice(0, 50)
			.map(({ id }) => ({
				value: `[[${target}#^${id}]]`,
				label: `#^${id}`,
				description: `Block · ${noteBasename(file)}`,
				consumeSuffix: "]]",
			}));
	}
	const headings = (cache?.headings ?? []).filter((row) => !!row.heading);
	if (headings.length === 0) return null;
	return headings.map((row) => ({ row, score: fuzzyScore(subQuery, row.heading) }))
		.filter((entry): entry is { row: (typeof headings)[number]; score: number } => entry.score !== null)
		.sort((a, b) => a.score - b.score || a.row.heading.localeCompare(b.row.heading))
		.slice(0, 50)
		.map(({ row }) => ({
			value: `[[${target}#${row.heading}]]`,
			label: row.heading,
			description: `H${row.level} · ${noteBasename(file)}`,
			consumeSuffix: "]]",
		}));
}

/** Full note → `#heading` / `#^block` dispatcher with a safe note-list
 * fallback for unresolved targets and missing/empty metadata. */
export function listWikilinkSuggestions(
	files: TFile[],
	rawQuery: string,
	getCache?: (file: TFile) => CachedMetadata | null,
): TokenSuggestion[] {
	const hash = rawQuery.indexOf("#");
	if (hash < 0) return listWikilinkNoteSuggestions(files, rawQuery);
	const target = rawQuery.slice(0, hash);
	const file = findWikilinkNote(files, target);
	if (file) {
		const sub = listWikilinkSubSuggestions(file, target, rawQuery.slice(hash + 1), getCache?.(file));
		if (sub !== null) return sub;
		return listWikilinkNoteSuggestions(files, target);
	}
	// An unresolved `target#…` must not strand the user without completions.
	return listWikilinkNoteSuggestions(files, "");
}

export class WikilinkSuggester extends TokenSuggester<WikilinkSuggesterOptions> {
	constructor(textarea: HTMLTextAreaElement, opts: WikilinkSuggesterOptions) {
		super(textarea, { ...opts, ariaLabel: "Wikilink completions" });
	}

	protected getPrefix(): string | null {
		const value = this.textarea.value ?? "";
		const cursor = this.textarea.selectionStart ?? value.length;
		return extractWikilinkPrefix(value.slice(0, cursor));
	}

	protected getSuggestions(prefix: string): TokenSuggestion[] {
		return listWikilinkSuggestions(this.opts.vault.getMarkdownFiles(), prefix.slice(2), (file) => {
			try {
				return this.opts.metadataCache?.getFileCache(file) ?? null;
			} catch {
				return null;
			}
		});
	}
}

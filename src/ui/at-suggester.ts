/**
 * FileAtSuggester — inline `@`-file autocomplete for the pi prompt composer
 * (Wave 2), adapted from the reference plugin's
 * `views/suggest/FileAtSuggester.ts` + `utils/fileSearch.ts`. It runs on the
 * native CodeMirror editor and the plain-textarea fallback through EditorSurface.
 *
 * Trigger: an `@` at a TOKEN BOUNDARY of the text before the cursor (start of
 * text or after a delimiter — space/tab/quote/'='), including an unclosed
 * `@"quoted path`. Selecting a file inserts `@path/to/file`; directories
 * insert `@folder/` so the user keeps drilling down. Esc dismisses; arrows +
 * Enter/Tab select.
 *
 * Filesystem: a PURE Node `fs` walk — NO `fd` binary dependency (the
 * reference's fd path is skipped entirely; its Node fallback is promoted to
 * the only path, but recursive with hard caps):
 *   - depth ≤ MAX_WALK_DEPTH levels below the query's directory,
 *   - ≤ MAX_WALK_ENTRIES entries collected per walk,
 *   - `.git` / `node_modules` always skipped,
 *   - top MAX_SUGGESTIONS fuzzy-scored results returned.
 * The fs surface is INJECTED (`FsDeps`) so smoke can drive the walker over a
 * fake tree with no real fs access; production defaults to `fs.readdirSync`.
 */
import { TokenSuggester, type TokenSuggestion, type TokenSuggesterOptions } from "./token-suggester";
import type { EditorSurface } from "./editor-surface";
export { insertCompletion } from "./token-suggester";

/** One completion item: `value` includes the leading `@` (+ trailing `/` for dirs). */
export interface FileSuggestion extends TokenSuggestion {}

/** Dirent-shaped entry — the only fs read the walker needs (injectable). */
export interface DirentLike {
	name: string;
	isDirectory(): boolean;
}

/** Injectable filesystem surface for the walker (production: `fs.readdirSync`). */
export interface FsDeps {
	readdir(dir: string): DirentLike[];
}

/** Recursion cap: entries deeper than this many levels below the query dir
 *  are never collected. */
export const MAX_WALK_DEPTH = 4;
/** Hard cap on entries collected per walk (bounds worst-case time + memory). */
export const MAX_WALK_ENTRIES = 2000;
/** Results returned to the popup after fuzzy scoring. */
export const MAX_SUGGESTIONS = 50;

/** Directory names never walked (huge / irrelevant to a prompt reference). */
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Lazily-built production fs deps (never touched when tests inject fakes). */
let defaultDeps: FsDeps | null = null;
function realFs(): FsDeps {
	if (!defaultDeps) {
		// Literal require: 'fs' is an esbuild external (builtin-modules) — kept
		// as a runtime require, never bundled.
		const fsp = require("fs") as typeof import("fs");
		defaultDeps = { readdir: (dir) => fsp.readdirSync(dir, { withFileTypes: true }) };
	}
	return defaultDeps;
}

// ------------------------------------------------------------------ trigger

const PATH_DELIMITERS = new Set([" ", "\t", "\n", "\r", "\"", "'", "="]);

function findLastDelimiter(text: string): number {
	for (let i = text.length - 1; i >= 0; i--) {
		if (PATH_DELIMITERS.has(text[i] ?? "")) return i;
	}
	return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) quoteStart = i;
		}
	}
	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

/** Extract the `@…` prefix for completion from the text before the cursor.
 *  Returns the prefix INCLUDING the leading `@`, or null when the cursor is
 *  not inside an `@` token. Ported from the reference `fileSearch.ts`. */
export function extractAtPrefix(text: string): string | null {
	// Quoted forms: @"path with spaces… (unclosed) — `@` must be at a token start.
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart !== null) {
		if (quoteStart > 0 && text[quoteStart - 1] === "@") {
			return isTokenStart(text, quoteStart - 1) ? text.slice(quoteStart - 1) : null;
		}
		return isTokenStart(text, quoteStart) ? text.slice(quoteStart) : null;
	}
	const lastDelimiterIndex = findLastDelimiter(text);
	const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
	if (text[tokenStart] === "@") return text.slice(tokenStart);
	return null;
}

/** Strip the leading `@` (+ opening quote) from a prefix → the raw path query. */
export function parseAtQuery(prefix: string): string {
	let raw = prefix.startsWith("@\"") ? prefix.slice(2) : prefix.startsWith("@") ? prefix.slice(1) : prefix;
	if (raw.startsWith('"')) raw = raw.slice(1);
	return raw;
}

// -------------------------------------------------------------------- walk

/** One walked filesystem entry, relative to the query directory. */
export interface WalkEntry {
	rel: string;
	isDir: boolean;
	/** Level below the query dir (entries directly in it = 1). */
	level: number;
}

export interface WalkOptions {
	maxDepth?: number;
	maxEntries?: number;
}

function joinRel(base: string, name: string): string {
	return base ? `${base}/${name}` : name;
}

/**
 * Bounded recursive walk of `dir` (injected fs). Collects entries up to
 * `maxDepth` levels (root entries = level 1) and stops at `maxEntries`.
 * `.git` / `node_modules` are skipped; unreadable dirs are silently skipped.
 * Pure over `deps` — exported for smoke (cap assertions without a big tree).
 */
export function walkFilesystem(dir: string, deps: FsDeps, opts: WalkOptions = {}): WalkEntry[] {
	const maxDepth = opts.maxDepth ?? MAX_WALK_DEPTH;
	const maxEntries = opts.maxEntries ?? MAX_WALK_ENTRIES;
	const out: WalkEntry[] = [];
	const walk = (cur: string, relBase: string, level: number): void => {
		if (level > maxDepth || out.length >= maxEntries) return;
		let dirents: DirentLike[];
		try {
			dirents = deps.readdir(cur);
		} catch {
			return; // missing/unreadable dir → nothing to offer from here
		}
		for (const d of dirents) {
			if (out.length >= maxEntries) return;
			if (SKIP_DIRS.has(d.name)) continue;
			const rel = joinRel(relBase, d.name);
			const isDir = d.isDirectory();
			out.push({ rel, isDir, level });
			if (isDir && level < maxDepth) walk(joinRelUnix(cur, d.name), rel, level + 1);
		}
	};
	walk(dir, "", 1);
	return out;
}

/** Join with '/' — the walker speaks display paths (works on Windows too). */
function joinRelUnix(base: string, name: string): string {
	return base ? `${base.replace(/\/+$/, "")}/${name}` : name;
}

// ------------------------------------------------------------------ scoring

/**
 * Fuzzy subsequence score (lower = better; null = no match). Ported from the
 * reference `utils/fuzzy.ts`: consecutive matches and word-boundary hits
 * subtract, gaps add, exact match gets a large bonus.
 */
export function fuzzyScore(query: string, text: string): number | null {
	if (!query) return 0;
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	if (q.length > t.length) return null;
	let qi = 0;
	let score = 0;
	let last = -1;
	let consecutive = 0;
	for (let i = 0; i < t.length && qi < q.length; i++) {
		if (t[i] !== q[qi]) continue;
		const boundary = i === 0 || /[\s\-_./:]/.test(t[i - 1] ?? "");
		if (last === i - 1) {
			consecutive++;
			score -= consecutive * 5;
		} else {
			consecutive = 0;
			if (last >= 0) score += (i - last - 1) * 2;
		}
		if (boundary) score -= 10;
		score += i * 0.1;
		last = i;
		qi++;
	}
	if (qi < q.length) return null;
	if (q === t) score -= 100;
	return score;
}

/**
 * Suggest files for an `@` path query relative to `baseDir`.
 *
 * The query is split into a SCOPED directory part (everything up to and
 * including the last `/`) and a name filter. The scoped directory is walked
 * (depth/entry-capped), each entry fuzzy-scored against the name filter (the
 * full relative path is the fallback haystack), and the best
 * `MAX_SUGGESTIONS` returned — directories first. `value` is the insertion
 * text: `@rel/path` (files) or `@rel/dir/` (dirs, so drilling continues).
 * Pure over `deps` — smoke injects a fake fs tree.
 */
export function listAtSuggestions(
	baseDir: string,
	rawQuery: string,
	deps: FsDeps = realFs(),
	opts: WalkOptions = {},
): FileSuggestion[] {
	const norm = rawQuery.replace(/\\/g, "/");
	const slash = norm.lastIndexOf("/");
	const scoped = slash >= 0 ? norm.slice(0, slash + 1) : "";
	const nameFilter = slash >= 0 ? norm.slice(slash + 1) : norm;
	const root = scoped ? joinRelUnix(baseDir, scoped.replace(/\/+$/, "")) : baseDir;

	const entries = walkFilesystem(root, deps, opts);
	const scored: { entry: WalkEntry; display: string; score: number }[] = [];
	for (const entry of entries) {
		const display = scoped ? joinRel(scoped.replace(/\/+$/, ""), entry.rel) : entry.rel;
		const name = entry.rel.split("/").pop() ?? entry.rel;
		if (nameFilter) {
			const byName = fuzzyScore(nameFilter, name);
			const score = byName ?? fuzzyScore(nameFilter, display);
			if (score === null) continue;
			scored.push({ entry, display, score: score + (entry.isDir ? -10 : 0) });
		} else {
			scored.push({ entry, display, score: entry.isDir ? -10 : 0 });
		}
	}
	scored.sort((a, b) => a.score - b.score || a.display.localeCompare(b.display));

	const out: FileSuggestion[] = [];
	for (const { entry, display } of scored) {
		if (out.length >= MAX_SUGGESTIONS) break;
		const value = `@${display}${entry.isDir ? "/" : ""}`;
		out.push({
			value,
			label: (entry.rel.split("/").pop() ?? display) + (entry.isDir ? "/" : ""),
			description: display,
		});
	}
	return out;
}

// -------------------------------------------------------------------- class

export interface FileAtSuggesterOptions extends TokenSuggesterOptions {
	/** The terminal cwd — `@` paths are relative to this (live: re-read on
	 *  every query so a cwd change re-targets the suggester). */
	baseDir: () => string | null;
	/** Injected fs (tests); production defaults to `fs.readdirSync`. */
	fs?: FsDeps;
}

/** Thin `@` driver over the shared token-suggester overlay. */
export class FileAtSuggester extends TokenSuggester<FileAtSuggesterOptions> {
	constructor(editor: EditorSurface, opts: FileAtSuggesterOptions) {
		super(editor, { ...opts, ariaLabel: "File completions" });
	}

	protected getPrefix(): string | null {
		const value = this.editor.getValue();
		const cursor = this.editor.getSelection().start;
		return extractAtPrefix(value.slice(0, cursor));
	}

	protected getSuggestions(prefix: string): FileSuggestion[] {
		const baseDir = this.opts.baseDir();
		return baseDir ? listAtSuggestions(baseDir, parseAtQuery(prefix), this.opts.fs) : [];
	}
}

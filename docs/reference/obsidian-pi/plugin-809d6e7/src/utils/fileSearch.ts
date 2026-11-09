/**
 * Filesystem file search utilities for the @-file-reference suggester.
 *
 * Ports the file-walking, scoring, and path-completion logic from
 * @earendil-works/pi-tui/dist/autocomplete.js. Uses the external `fd` binary
 * when available (fast, .gitignore-aware) and falls back to a synchronous
 * Node.js directory walk otherwise.
 */

import { fuzzyFilter } from './fuzzy';

let fsMod: typeof import('fs') | null = null;
function getFs(): typeof import('fs') { return fsMod ?? (fsMod = require('fs')); }
let osMod: typeof import('os') | null = null;
function getOs(): typeof import('os') { return osMod ?? (osMod = require('os')); }
let pathMod: typeof import('path') | null = null;
function getPath(): typeof import('path') { return pathMod ?? (pathMod = require('path')); }

const PATH_DELIMITERS = new Set([' ', '\t', '"', "'", '=']);

export interface FileSearchEntry {
  path: string;
  isDirectory: boolean;
}

export interface FileSuggestion {
  value: string;
  label: string;
  description?: string;
}

export interface FuzzyFileOptions {
  isQuotedPrefix?: boolean;
  signal?: AbortSignal;
  maxResults?: number;
}

function toDisplayPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFdPathQuery(query: string): string {
  const normalized = toDisplayPath(query);
  if (!normalized.includes('/')) {
    return normalized;
  }
  const hasTrailingSeparator = normalized.endsWith('/');
  const trimmed = normalized.replace(/^\/+|\/+$/g, '');
  if (!trimmed) {
    return normalized;
  }
  const separatorPattern = '[\\\\/]';
  const segments = trimmed
    .split('/')
    .filter(Boolean)
    .map((segment) => escapeRegex(segment));
  if (segments.length === 0) {
    return normalized;
  }
  let pattern = segments.join(separatorPattern);
  if (hasTrailingSeparator) {
    pattern += separatorPattern;
  }
  return pattern;
}

function findLastDelimiter(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(text[i] ?? '')) {
      return i;
    }
  }
  return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
  let inQuotes = false;
  let quoteStart = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) {
        quoteStart = i;
      }
    }
  }
  return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
  return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? '');
}

function extractQuotedPrefix(text: string): string | null {
  const quoteStart = findUnclosedQuoteStart(text);
  if (quoteStart === null) {
    return null;
  }
  if (quoteStart > 0 && text[quoteStart - 1] === '@') {
    if (!isTokenStart(text, quoteStart - 1)) {
      return null;
    }
    return text.slice(quoteStart - 1);
  }
  if (!isTokenStart(text, quoteStart)) {
    return null;
  }
  return text.slice(quoteStart);
}

export function parsePathPrefix(prefix: string): { rawPrefix: string; isAtPrefix: boolean; isQuotedPrefix: boolean } {
  if (prefix.startsWith('@"')) {
    return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
  }
  if (prefix.startsWith('"')) {
    return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
  }
  if (prefix.startsWith('@')) {
    return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
  }
  return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

export function buildCompletionValue(
  path: string,
  options: { isDirectory?: boolean; isAtPrefix?: boolean; isQuotedPrefix?: boolean },
): string {
  const needsQuotes = options.isQuotedPrefix || path.includes(' ');
  const prefix = options.isAtPrefix ? '@' : '';
  if (!needsQuotes) {
    return `${prefix}${path}`;
  }
  return `${prefix}"${path}"`;
}

export function expandHomePath(path: string): string {
  if (path.startsWith('~/')) {
    const expandedPath = getPath().join(getOs().homedir(), path.slice(2));
    return path.endsWith('/') && !expandedPath.endsWith(getPath().sep) ? `${expandedPath}${getPath().sep}` : expandedPath;
  } else if (path === '~') {
    return getOs().homedir();
  }
  return path;
}

/**
 * Spawn `fd` to walk the directory tree (fast, respects .gitignore).
 */
export async function walkDirectoryWithFd(
  baseDir: string,
  fdPath: string,
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<FileSearchEntry[]> {
  const args = [
    '--base-directory',
    baseDir,
    '--max-results',
    String(maxResults),
    '--type',
    'f',
    '--type',
    'd',
    '--follow',
    '--hidden',
    '--exclude',
    '.git',
    '--exclude',
    '.git/*',
    '--exclude',
    '.git/**',
  ];

  if (toDisplayPath(query).includes('/')) {
    args.push('--full-path');
  }
  if (query) {
    args.push(buildFdPathQuery(query));
  }

  const { spawn } = require('child_process') as typeof import('child_process');

  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve([]);
      return;
    }

    const child = spawn(fdPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let resolved = false;

    const finish = (results: FileSearchEntry[]) => {
      if (resolved) return;
      resolved = true;
      signal.removeEventListener('abort', onAbort);
      resolve(results);
    };

    const onAbort = () => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    };

    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => {
      finish([]);
    });
    child.on('close', (code) => {
      if (signal.aborted || code !== 0 || !stdout) {
        finish([]);
        return;
      }
      const lines = stdout.trim().split('\n').filter(Boolean);
      const results: FileSearchEntry[] = [];
      for (const line of lines) {
        const displayLine = toDisplayPath(line);
        const hasTrailingSeparator = displayLine.endsWith('/');
        const normalizedPath = hasTrailingSeparator ? displayLine.slice(0, -1) : displayLine;
        if (
          normalizedPath === '.git' ||
          normalizedPath.startsWith('.git/') ||
          normalizedPath.includes('/.git/')
        ) {
          continue;
        }
        results.push({
          path: displayLine,
          isDirectory: hasTrailingSeparator,
        });
      }
      finish(results);
    });
  });
}

export interface ScopedQuery {
  baseDir: string;
  query: string;
  displayBase: string;
}

export function resolveScopedFuzzyQuery(rawQuery: string, basePath: string): ScopedQuery | null {
  const normalizedQuery = toDisplayPath(rawQuery);
  const slashIndex = normalizedQuery.lastIndexOf('/');
  if (slashIndex === -1) {
    return null;
  }
  const displayBase = normalizedQuery.slice(0, slashIndex + 1);
  const query = normalizedQuery.slice(slashIndex + 1);

  let baseDir: string;
  if (displayBase.startsWith('~/')) {
    baseDir = expandHomePath(displayBase);
  } else if (displayBase.startsWith('/')) {
    baseDir = displayBase;
  } else {
    baseDir = getPath().join(basePath, displayBase);
  }

  try {
    if (!getFs().statSync(baseDir).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  return { baseDir, query, displayBase };
}

export function scopedPathForDisplay(displayBase: string, relativePath: string): string {
  const normalizedRelativePath = toDisplayPath(relativePath);
  if (displayBase === '/') {
    return `/${normalizedRelativePath}`;
  }
  return `${toDisplayPath(displayBase)}${normalizedRelativePath}`;
}

/**
 * Synchronous directory-walk fallback when `fd` is unavailable.
 * Only lists the contents of a single directory (no recursion) and is used for
 * path-prefix style completion.
 */
export function getFileSuggestions(baseDir: string, prefix: string): FileSuggestion[] {
  try {
    let searchDir: string;
    let searchPrefix: string;

    const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
    let expandedPrefix = rawPrefix;

    if (expandedPrefix.startsWith('~')) {
      expandedPrefix = expandHomePath(expandedPrefix);
    }

    const isRootPrefix =
      rawPrefix === '' ||
      rawPrefix === './' ||
      rawPrefix === '../' ||
      rawPrefix === '~' ||
      rawPrefix === '~/' ||
      rawPrefix === '/' ||
      (isAtPrefix && rawPrefix === '');

    if (isRootPrefix || rawPrefix.endsWith('/')) {
      if (rawPrefix.startsWith('~') || expandedPrefix.startsWith('/')) {
        searchDir = expandedPrefix;
      } else {
        searchDir = getPath().join(baseDir, expandedPrefix);
      }
      searchPrefix = '';
    } else {
      const dir = getPath().dirname(expandedPrefix);
      const file = getPath().basename(expandedPrefix);
      if (rawPrefix.startsWith('~') || expandedPrefix.startsWith('/')) {
        searchDir = dir;
      } else {
        searchDir = getPath().join(baseDir, dir);
      }
      searchPrefix = file;
    }

    const entries = getFs().readdirSync(searchDir, { withFileTypes: true });
    const suggestions: FileSuggestion[] = [];

    for (const entry of entries) {
      if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
        continue;
      }

      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          const fullPath = getPath().join(searchDir, entry.name);
          isDirectory = getFs().statSync(fullPath).isDirectory();
        } catch {
          // Broken symlink or permission error — treat as file.
        }
      }

      const name = entry.name;
      const displayPrefix = rawPrefix;
      let relativePath: string;

      if (displayPrefix.endsWith('/')) {
        relativePath = displayPrefix + name;
      } else if (displayPrefix.includes('/') || displayPrefix.includes('\\')) {
        if (displayPrefix.startsWith('~/')) {
          const homeRelativeDir = displayPrefix.slice(2);
          const dir = getPath().dirname(homeRelativeDir);
          relativePath = `~/${dir === '.' ? name : getPath().join(dir, name)}`;
        } else if (displayPrefix.startsWith('/')) {
          const dir = getPath().dirname(displayPrefix);
          relativePath = dir === '/' ? `/${name}` : `${dir}/${name}`;
        } else {
          relativePath = getPath().join(getPath().dirname(displayPrefix), name);
          if (displayPrefix.startsWith('./') && !relativePath.startsWith('./')) {
            relativePath = `./${relativePath}`;
          }
        }
      } else {
        if (displayPrefix.startsWith('~')) {
          relativePath = `~/${name}`;
        } else {
          relativePath = name;
        }
      }

      relativePath = toDisplayPath(relativePath);
      const pathValue = isDirectory ? `${relativePath}/` : relativePath;
      const value = buildCompletionValue(pathValue, { isDirectory, isAtPrefix, isQuotedPrefix });
      suggestions.push({
        value,
        label: name + (isDirectory ? '/' : ''),
      });
    }

    suggestions.sort((a, b) => {
      const aIsDir = a.value.endsWith('/');
      const bIsDir = b.value.endsWith('/');
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.label.localeCompare(b.label);
    });

    return suggestions;
  } catch {
    return [];
  }
}

/**
 * Score a file/directory entry against a query (higher = better match).
 * Directories receive a small bonus to prioritize folders.
 */
export function scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
  const fileName = getPath().basename(filePath);
  const lowerFileName = fileName.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = 0;

  if (lowerFileName === lowerQuery) {
    score = 100;
  } else if (lowerFileName.startsWith(lowerQuery)) {
    score = 80;
  } else if (lowerFileName.includes(lowerQuery)) {
    score = 50;
  } else if (filePath.toLowerCase().includes(lowerQuery)) {
    score = 30;
  }

  if (isDirectory && score > 0) {
    score += 10;
  }

  return score;
}

/**
 * Fuzzy file search using `fd` (preferred) or a synchronous directory walk
 * fallback. Results are returned as file-reference completion items.
 */
export async function getFuzzyFileSuggestions(
  basePath: string,
  fdPath: string | null,
  query: string,
  options: FuzzyFileOptions = {},
): Promise<FileSuggestion[]> {
  const { isQuotedPrefix = false, signal, maxResults = 100 } = options;

  if (!fdPath || signal?.aborted) {
    return getFileSuggestions(basePath, query);
  }

  const effectiveSignal = signal ?? new AbortController().signal;

  try {
    const scopedQuery = resolveScopedFuzzyQuery(query, basePath);
    const fdBaseDir = scopedQuery?.baseDir ?? basePath;
    const fdQuery = scopedQuery?.query ?? query;
    const entries = await walkDirectoryWithFd(fdBaseDir, fdPath, fdQuery, maxResults, effectiveSignal);

    if (effectiveSignal.aborted) {
      return [];
    }

    const scoredEntries = entries
      .map((entry) => ({
        ...entry,
        score: fdQuery ? scoreEntry(entry.path, fdQuery, entry.isDirectory) : 1,
      }))
      .filter((entry) => entry.score > 0);

    scoredEntries.sort((a, b) => b.score - a.score);
    const topEntries = scoredEntries.slice(0, 20);
    const suggestions: FileSuggestion[] = [];

    for (const { path: entryPath, isDirectory } of topEntries) {
      const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
      const displayPath = scopedQuery
        ? scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
        : pathWithoutSlash;
      const entryName = getPath().basename(pathWithoutSlash);
      const completionPath = isDirectory ? `${displayPath}/` : displayPath;
      const value = buildCompletionValue(completionPath, {
        isDirectory,
        isAtPrefix: true,
        isQuotedPrefix,
      });
      suggestions.push({
        value,
        label: entryName + (isDirectory ? '/' : ''),
        description: displayPath,
      });
    }

    return suggestions;
  } catch {
    return [];
  }
}

/**
 * Extract an `@` prefix for file-reference autocomplete from the text before
 * the cursor. Returns the prefix string including the leading `@`, or null.
 */
export function extractAtPrefix(text: string): string | null {
  const quotedPrefix = extractQuotedPrefix(text);
  if (quotedPrefix?.startsWith('@"')) {
    return quotedPrefix;
  }
  const lastDelimiterIndex = findLastDelimiter(text);
  const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
  if (text[tokenStart] === '@') {
    return text.slice(tokenStart);
  }
  return null;
}

/**
 * Extract a path-like prefix from the text before the cursor.
 */
export function extractPathPrefix(text: string, forceExtract = false): string | null {
  const quotedPrefix = extractQuotedPrefix(text);
  if (quotedPrefix) {
    return quotedPrefix;
  }
  const lastDelimiterIndex = findLastDelimiter(text);
  const pathPrefix = lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);

  if (forceExtract) {
    return pathPrefix;
  }

  if (pathPrefix.includes('/') || pathPrefix.startsWith('.') || pathPrefix.startsWith('~/')) {
    return pathPrefix;
  }
  if (pathPrefix === '' && text.endsWith(' ')) {
    return pathPrefix;
  }
  return null;
}

/**
 * Check whether file completion should be triggered. Used by explicit Tab-key
 * handlers to avoid competing with slash-command completion at line start.
 */
export function shouldTriggerFileCompletion(textBeforeCursor: string): boolean {
  const trimmed = textBeforeCursor.trim();
  if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
    return false;
  }
  return true;
}

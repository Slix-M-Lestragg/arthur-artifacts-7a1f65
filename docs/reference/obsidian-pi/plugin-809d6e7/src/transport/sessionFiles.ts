/**
 * Shared helpers for listing pi session `.jsonl` files directly off disk.
 *
 * Used by both the RPC-driven SessionPanel (chat view) and the PTY-driven
 * TerminalView's session picker — the latter has no RPC channel to introspect
 * the live session, so resuming a session is done by listing files here and
 * restarting the PTY subprocess with `--session <path>` rather than driving
 * pi's own `/resume` TUI overlay.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface SessionFileInfo {
  path: string;
  /** Filename without the .jsonl extension. */
  name: string;
  /** Display name — the session's set name if any, else falls back to `name`. */
  displayName: string;
  mtime: number;
}

/**
 * Read a session file's last `session_info` entry to get its display name
 * (the name can be set/changed at any point during the session's lifetime,
 * so the *last* occurrence wins — scan from the end).
 */
export function extractSessionName(filePath: string, mtimeMs?: number): string | null {
  try {
    // Session files grow to MBs and this runs on the UI thread (panel renders,
    // after every turn) — read only the tail and cache the result by mtime.
    const mtime = mtimeMs ?? fs.statSync(filePath).mtimeMs;
    const cached = nameCache.get(filePath);
    if (cached && cached.mtimeMs === mtime) return cached.name;
    const name = readSessionNameFromTail(filePath);
    nameCache.set(filePath, { mtimeMs: mtime, name });
    return name;
  } catch { /* file may be locked or unreadable */ }
  return null;
}

/** Cache of resolved session names, invalidated by mtime. */
const nameCache = new Map<string, { mtimeMs: number; name: string | null }>();

/** Bytes read from the end of a session file when resolving its name. */
const NAME_TAIL_BYTES = 64 * 1024;

/** Scan the last NAME_TAIL_BYTES of a session file for its latest session_info name. */
function readSessionNameFromTail(filePath: string): string | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - NAME_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let content = buf.toString('utf-8');
    // If we started mid-file, drop the (possibly partial) first line.
    if (start > 0) {
      const nl = content.indexOf('\n');
      content = nl === -1 ? '' : content.slice(nl + 1);
    }
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('session_info')) continue; // fast skip
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'session_info' && entry.name) {
          return entry.name as string;
        }
      } catch { /* skip non-JSON lines */ }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Return the newest `.jsonl` session file path in a directory (or null).
 * Cheap: readdir + stat only — no file contents are read. Use this instead of
 * listSessionFilesInDir() when display names aren't needed (e.g. persisting
 * the active terminal session after every turn).
 */
export function newestSessionFileInDir(dir: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let newest: { path: string; mtime: number } | null = null;
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const fullPath = path.join(dir, e.name);
      const mtime = fs.statSync(fullPath).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path: fullPath, mtime };
    }
    return newest?.path ?? null;
  } catch {
    return null;
  }
}

/** List `.jsonl` session files in a directory, newest first, with display names resolved. */
export function listSessionFilesInDir(dir: string): SessionFileInfo[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => {
        const fullPath = path.join(dir, e.name);
        const stat = fs.statSync(fullPath);
        const fileName = e.name.replace(/\.jsonl$/, '');
        const sessionName = extractSessionName(fullPath, stat.mtimeMs);
        return {
          path: fullPath,
          name: fileName,
          displayName: sessionName ?? fileName,
          mtime: stat.mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first
  } catch {
    return [];
  }
}

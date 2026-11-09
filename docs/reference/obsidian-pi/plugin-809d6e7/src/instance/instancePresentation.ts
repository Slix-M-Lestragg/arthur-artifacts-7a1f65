/**
 * instancePresentation — shared formatting + projection helpers for rendering
 * a pi instance row across surfaces (menubar snapshot, ribbon hub, hover
 * tooltips, Farm View local rows).
 *
 * Historically `formatAgo()` was copy-pasted three times (menubarSnapshot,
 * InstanceStats, AhpSessionPickerModal), `formatTokens()` twice, and every
 * surface re-projected its own instance-row shape. They live here now — one
 * home, one behavior.
 *
 * Node-free and mobile-safe: imports types only.
 */

import type { PiTerminalIconState } from '../views/TerminalIcon';
import type { PtyClientState } from '../transport/PtyClient';
import type { PiInstance } from './InstanceManager';

// ─── Relative-time formatting ───────────────────────────────────────────────

/**
 * Coarse relative timestamp for "Xm ago" lines: "3s ago" / "5m ago" / "2h ago"
 * / "1d ago" / "just now". Deliberately coarse — this is a label, not a clock.
 * Takes an explicit `now` so callers (and tests) stay deterministic.
 */
export function formatAgo(atMs: number, now: number = Date.now()): string {
  const deltaS = Math.max(0, Math.round((now - atMs) / 1000));
  if (deltaS < 5) return 'just now';
  if (deltaS < 60) return `${deltaS}s ago`;
  const deltaM = Math.round(deltaS / 60);
  if (deltaM < 60) return `${deltaM}m ago`;
  const deltaH = Math.round(deltaM / 60);
  if (deltaH < 24) return `${deltaH}h ago`;
  return `${Math.round(deltaH / 24)}d ago`;
}

/**
 * ISO-string variant of {@link formatAgo} (used by AHP session surfaces whose
 * timestamps arrive as ISO strings). Returns undefined for missing/invalid input.
 */
export function formatAgoIso(iso?: string, now: number = Date.now()): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  return formatAgo(at, now);
}

// ─── Number / cost formatting ───────────────────────────────────────────────

/** Format a token count compactly: 12400 -> "12.4k", 1377276 -> "1.4M". */
export function formatTokens(n?: number): string | undefined {
  if (n === undefined || n === null || n <= 0) return undefined;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Format a USD cost as "$0.1234"; em-dash for unknown. */
export function formatCost(cost?: number): string {
  if (cost == null) return '—';
  return `$${cost.toFixed(4)}`;
}

// ─── Instance-row projection ────────────────────────────────────────────────

/**
 * Serializable view of one pi terminal instance — carries only what a row
 * renderer needs (label, status glyph, short detail). Free of any Electron /
 * Obsidian-DOM types so it round-trips through JSON cleanly (menubar IPC).
 *
 * The menubar's `MenubarInstance` is exactly this projection; Farm View local
 * rows and the ribbon hub render the same fields from the live PiInstance.
 */
export interface InstanceRow {
  id: string;
  name: string;
  /** Basename of the instance's effective cwd (or the vault root when empty). */
  cwdBasename: string;
  iconState: PiTerminalIconState;
  ptyState: PtyClientState | null;
  model?: string;
  contextPercent?: number | null;
  /** Assistant turn count from the last completed turn. */
  turns?: number;
  cost?: number;
  lastEventAt?: number;
  /** Error message from the last 'error' event, if the last event was an error. */
  lastErrorMessage?: string;
  awaitingInput: boolean;
}

/** Minimal shape of an instance config needed for the projection. */
export interface InstanceRowConfig {
  id: string;
  name: string;
  cwd?: string;
}

/**
 * Project a configured instance (+ its live runtime, when running) onto an
 * {@link InstanceRow}. Falls back to idle/disconnected defaults when the
 * runtime hasn't spawned yet.
 */
export function toInstanceRow(
  cfg: InstanceRowConfig,
  runtime: PiInstance | undefined,
  vaultPath: string,
): InstanceRow {
  return {
    id: cfg.id,
    name: cfg.name,
    cwdBasename: basename(cfg.cwd || vaultPath) || cfg.name,
    iconState: runtime?.iconState ?? 'idle',
    ptyState: runtime?.ptyClient?.state ?? null,
    model: runtime?.stats?.model,
    contextPercent: runtime?.stats?.contextPercent,
    turns: runtime?.stats?.turns,
    cost: runtime?.stats?.cost,
    lastEventAt: runtime?.stats?.lastEventAt,
    lastErrorMessage: runtime?.stats?.lastErrorMessage,
    awaitingInput: !!runtime?.awaitingInput,
  };
}

/** Path-basename helper (avoids a Node `path` import — keeps this module
 *  loadable on mobile). Handles both separators. */
function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? p : p.slice(idx + 1);
}
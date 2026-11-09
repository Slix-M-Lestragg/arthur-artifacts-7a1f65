import type { AgentEvent } from '../notifications/AgentNotifier';
import { formatAgo, formatCost } from './instancePresentation';
import type { PiInstance } from './InstanceManager';

/**
 * Rolling snapshot of the last known agent activity for one instance, updated
 * on every PtyClient notify event (see InstanceManager.ensurePtyClient). Used
 * to build the hover tooltip shown on the terminal tab icon, the terminal
 * toolbar instance label, and the ribbon instance-hub buttons.
 */
export interface InstanceStats {
  /** Most recent lifecycle event type observed ('start'/'question'/'end'/'error'/'abort'). */
  lastEventType?: AgentEvent['type'];
  /** Timestamp (Date.now()) of the last event, for a relative "Xm ago" line. */
  lastEventAt?: number;
  /** Current/most-recently-seen model id \u2014 kept fresh on every event, not just 'end'. */
  model?: string;
  /** Current thinking level \u2014 kept fresh on every event. */
  thinkingLevel?: string;
  /** Current context window usage in tokens, or null when unknown (e.g. right after compaction). */
  contextTokens?: number | null;
  /** The active model's context window size, in tokens. */
  contextWindow?: number;
  /** Context usage as a percentage of contextWindow, or null when unknown. */
  contextPercent?: number | null;
  /** Assistant turn count from the last completed turn. */
  turns?: number;
  /** Output token count from the last completed turn. */
  tokens?: number;
  /** USD cost from the last completed turn. */
  cost?: number;
  /** Error message from the last 'error' event, if the last event was an error. */
  lastErrorMessage?: string;
}

/** Update an instance's rolling stats snapshot in place from a fresh notify event. */
export function updateInstanceStats(stats: InstanceStats, event: AgentEvent): void {
  stats.lastEventType = event.type;
  stats.lastEventAt = Date.now();

  // "Live" fields \u2014 kept current regardless of which event type carried them,
  // since they reflect current runtime state (not a specific turn's result).
  if (event.model !== undefined) stats.model = event.model;
  if (event.thinkingLevel !== undefined) stats.thinkingLevel = event.thinkingLevel;
  if (event.contextTokens !== undefined) stats.contextTokens = event.contextTokens;
  if (event.contextWindow !== undefined) stats.contextWindow = event.contextWindow;
  if (event.contextPercent !== undefined) stats.contextPercent = event.contextPercent;

  if (event.type === 'end') {
    stats.turns = event.turns;
    stats.tokens = event.tokens;
    stats.cost = event.cost;
    stats.lastErrorMessage = undefined;
  } else if (event.type === 'error') {
    stats.lastErrorMessage = event.message;
  } else if (event.type === 'start') {
    stats.lastErrorMessage = undefined;
  }
}

/** Coarse relative timestamp for tooltip lines — canonical implementation in
 *  ./instancePresentation. */

function statusLine(instance: PiInstance): string {
  const ptyState = instance.ptyClient?.state;
  switch (instance.iconState) {
    case 'running':        return '● Running…';
    case 'awaiting-input':  return '❓ Waiting for your input';
    case 'done-unseen':
    case 'seen':            return '✓ Done';
    case 'error':           return `✖ Error${instance.stats.lastErrorMessage ? `: ${instance.stats.lastErrorMessage}` : ''}`;
    default:
      if (!ptyState || ptyState === 'disconnected') return 'Not connected';
      if (ptyState === 'connected') return 'Idle';
      return ptyState; // connecting / reconnecting / crashed
  }
}

/** "claude-3-5-sonnet · thinking: medium" — either half omitted if unknown. */
function modelLine(stats: InstanceStats): string | null {
  const parts: string[] = [];
  if (stats.model) parts.push(stats.model);
  if (stats.thinkingLevel && stats.thinkingLevel !== 'none') parts.push(`thinking: ${stats.thinkingLevel}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** "Context: 12,345 / 200,000 tokens (6%)" \u2014 degrades gracefully as less becomes known. */
function contextLine(stats: InstanceStats): string | null {
  if (stats.contextTokens == null) return null;
  const tokens = stats.contextTokens.toLocaleString();
  if (!stats.contextWindow) return `Context: ${tokens} tokens`;
  const window = stats.contextWindow.toLocaleString();
  const pct = stats.contextPercent != null ? ` (${Math.round(stats.contextPercent)}%)` : '';
  return `Context: ${tokens} / ${window} tokens${pct}`;
}

function costLine(stats: InstanceStats): string | null {
  return stats.cost != null && stats.cost > 0 ? `Cost: ${formatCost(stats.cost)}` : null;
}

/**
 * Multi-line hover tooltip text for an instance: name, live status, model +
 * thinking level, context window usage, and cost (from the last completed
 * turn), plus a coarse "Xm ago" timestamp. Obsidian's native tooltip
 * (setTooltip) renders `\n` as line breaks. Deliberately omits the working
 * directory to keep the tooltip compact.
 */
export function buildInstanceTooltip(instance: PiInstance): string {
  const lines: string[] = [instance.config.name, '', statusLine(instance)];
  const model = modelLine(instance.stats);
  if (model) lines.push(model);
  const context = contextLine(instance.stats);
  if (context) lines.push(context);
  const cost = costLine(instance.stats);
  if (cost) lines.push(cost);
  if (instance.stats.lastEventAt) lines.push(formatAgo(instance.stats.lastEventAt));
  return lines.join('\n');
}

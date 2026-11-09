/**
 * ahpStatus — the single home for the AHP session-status wire vocabulary.
 *
 * The Farm View server describes session state as a bitmask (server
 * `SessionStatus`, feature/farm-view-server src/types.ts). This module owns
 * that vocabulary end-to-end:
 *
 *  - `statusInfo()`   — the ONE decoder: bitmask → display label/class.
 *  - `mapLocalStatus()` — the ONE encoder: local PiInstance → bitmask
 *    (consumed by HostAgentClient's `hostAgent.syncInstances` upserts).
 *  - `sessionStatusInfo()` — decoder for the string-based `currentAction`
 *    field that accompanies the bitmask in session summaries.
 *
 * Historically these lived in three places with drifting copies (FarmView's
 * decoder, HostAgentClient's encoder constants, and a string-based decoder in
 * AhpSessionPickerModal) — two decoders for one wire field is an active-bug
 * hazard, so they are merged here.
 *
 * Node-free and mobile-safe: imports types only.
 */

import type { SessionSummary } from './AhpClient';
import type { PiInstance } from '../instance/InstanceManager';

// ─── Server SessionStatus bits (feature/farm-view-server src/types.ts) ──────

export const STATUS_ACTIVE = 1;
export const STATUS_ERROR = 2;
export const STATUS_DONE = 4;
export const STATUS_RUNNING = 8;
/** Input is a sub-state of a running turn; its value (24) overlaps Running (8). */
export const STATUS_INPUT = 24;
export const STATUS_ARCHIVED = 64;
export const STATUS_WAITING = 128;
export const STATUS_QUEUED = 256;
export const STATUS_THROTTLED = 512;

// ─── Bitmask decoder ────────────────────────────────────────────────────────

export interface StatusInfo {
  label: string;
  cls: string;
  isArchived: boolean;
}

/** Decode a server SessionStatus bitmask into a display label + class. */
export function statusInfo(status: number): StatusInfo {
  const isArchived = (status & STATUS_ARCHIVED) !== 0;
  if (isArchived) {
    return { label: 'archived', cls: 'pi-farm-status-archived', isArchived: true };
  }
  // Input is a more specific sub-state of a running turn (agent awaiting input),
  // so it takes precedence over the generic running bit even though its value
  // (24) overlaps with Running (8).
  if ((status & STATUS_INPUT) === STATUS_INPUT) {
    return { label: 'input', cls: 'pi-farm-status-input', isArchived: false };
  }
  if ((status & STATUS_RUNNING) !== 0) {
    return { label: 'running', cls: 'pi-farm-status-running', isArchived: false };
  }
  // Waiting only applies when the main chat is not running but child chats are.
  if ((status & STATUS_WAITING) !== 0) {
    return { label: 'waiting', cls: 'pi-farm-status-waiting', isArchived: false };
  }
  // Scheduler-waiting states come after normal waiting, before terminal/error bits.
  if ((status & STATUS_QUEUED) !== 0) {
    return { label: 'queued', cls: 'pi-farm-status-queued', isArchived: false };
  }
  if ((status & STATUS_THROTTLED) !== 0) {
    return { label: 'throttled', cls: 'pi-farm-status-throttled', isArchived: false };
  }
  if ((status & STATUS_ERROR) !== 0) {
    return { label: 'error', cls: 'pi-farm-status-error', isArchived: false };
  }
  if ((status & STATUS_DONE) !== 0) {
    return { label: 'done', cls: 'pi-farm-status-done', isArchived: false };
  }
  if ((status & STATUS_ACTIVE) !== 0) {
    return { label: 'active', cls: 'pi-farm-status-active', isArchived: false };
  }
  return { label: 'idle', cls: 'pi-farm-status-idle', isArchived: false };
}

// ─── Bitmask encoder ────────────────────────────────────────────────────────

/** Map a local PiInstance's runtime state onto the server's SessionStatus bits. */
export function mapLocalStatus(instance: PiInstance): number {
  if (instance.awaitingInput) return STATUS_INPUT;
  switch (instance.iconState) {
    case 'running':     return STATUS_RUNNING;
    case 'done-unseen':
    case 'seen':        return STATUS_DONE;
    case 'error':       return STATUS_ERROR;
    default:            return STATUS_ACTIVE;
  }
}

// ─── currentAction (string) decoder ─────────────────────────────────────────

/** Status indicator for a session's currentAction. Returns a colored dot class
 *  + label, or undefined if the action isn't worth showing. */
export function sessionStatusInfo(s: SessionSummary): { dotCls: string; label: string } | undefined {
  const action = s.currentAction;
  if (!action || action === 'idle') return undefined;
  if (action === 'running' || action === 'thinking' || action === 'working') return { dotCls: 'pi-ahp-dot-running', label: action };
  if (action === 'waiting' || action === 'waiting_for_user' || action === 'awaiting_input') return { dotCls: 'pi-ahp-dot-waiting', label: 'waiting' };
  if (action === 'error' || action === 'failed') return { dotCls: 'pi-ahp-dot-error', label: 'error' };
  return { dotCls: 'pi-ahp-dot-active', label: action };
}
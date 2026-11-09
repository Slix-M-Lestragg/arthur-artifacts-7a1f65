import { Notice, type App } from 'obsidian';
import { isAhpError } from './AhpError';
import { errorMessage } from '../utils/errors';
import type { AhpClient } from './AhpClient';
import type { SessionSummary } from './AhpClient';
import { confirmLiveMirrorSession } from '../views/AhpSessionPickerModal';

/**
 * Minimal surface the unified AHP session-attach helper needs from the plugin.
 * Kept narrow so the helper can be unit-tested with a lightweight mock host.
 */
export interface AhpSessionHost {
  app: unknown;
  ahpClient: AhpClient | null;
  /** Register (or replace) the synthetic AHP instance; returns its id
   *  ('ahp-remote-N') which MUST be forwarded to activateAhpTerminalView so
   *  the leaf binds the right runtime instance (tab icon / commands / hub). */
  registerAhpInstance(title: string): string;
  /** Open the AHP terminal view bound to the session's interactive terminal
   *  channel (`ahp-terminal:`), replaying the subscribe snapshot. Mirrors the
   *  plugin's full signature (readOnly before ahpInstanceId) so the plugin
   *  satisfies this interface structurally. */
  activateAhpTerminalView(
    terminalUri?: string | null,
    terminalMode?: 'external' | 'server-spawned' | 'none' | null,
    initialCols?: number,
    initialRows?: number,
    initialContent?: string,
    readOnly?: boolean,
    ahpInstanceId?: string,
  ): Promise<void>;
}

/**
 * Extract the initial terminal size and screen content from a server-side
 * terminal-channel subscribe snapshot.
 *
 * The server serializes TerminalState with BOTH legacy `screenText` (a plain
 * string, older servers) and the M2 accumulator `content` (an array of
 * `{type:'unclassified', value}` / `{type:'command', output}` parts — the
 * external-terminal relay replays exactly this). `screenText` wins when
 * present; otherwise the content parts are concatenated in order.
 */
export function extractTerminalSnapshot(
  snapshot: unknown,
): {
  initialCols?: number;
  initialRows?: number;
  initialContent?: string;
} {
  const snap = (snapshot ?? {}) as Record<string, unknown>;
  const terminalSnap = (snap.snapshot ?? snap) as Record<string, unknown>;
  const state = (terminalSnap.state ?? {}) as Record<string, unknown>;
  const initialCols = typeof state.cols === 'number' ? state.cols : undefined;
  const initialRows = typeof state.rows === 'number' ? state.rows : undefined;
  const screenText = typeof state.screenText === 'string' ? state.screenText : undefined;
  const initialContent =
    (screenText && screenText.length > 0 ? screenText : undefined) ??
    terminalContentText(state.content);
  return { initialCols, initialRows, initialContent };
}

/**
 * Reconstruct the accumulated scrollback from a TerminalState.content part
 * array (`{type:'unclassified', value}` for raw PTY data; command parts carry
 * their text in `output`). Returns undefined for an empty/missing array so a
 * late opener falls back to a fresh terminal rather than a blank replay.
 */
function terminalContentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  let out = '';
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as { type?: unknown; value?: unknown; output?: unknown };
    if (part.type === 'command') {
      if (typeof part.output === 'string') out += part.output;
    } else if (typeof part.value === 'string') {
      out += part.value;
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Eagerly establish a newly-created hosted session's terminal channel so it
 * opens directly in persistent, multi-client interactive terminal mode.
 */
export async function createHostedAhpSession(
  host: AhpSessionHost,
  sessionUri: string,
  title: string,
  client: AhpClient,
): Promise<void> {
  const terminalUri = sessionUri.replace(/^ahp-session:/, 'ahp-terminal:');
  await client.subscribe(sessionUri);
  const snapshot = await client.subscribe(terminalUri);
  const { initialCols, initialRows, initialContent } = extractTerminalSnapshot(snapshot);
  // Forward the returned instance id so the leaf binds 'ahp-remote-N', not the
  // hardcoded 'ahp-remote' default (same bug as openAhpTerminalForChat).
  const ahpId = host.registerAhpInstance(title);
  if (ahpId) {
    // readOnly stays undefined; the id lands in the 7th slot (ahpInstanceId)
    // so the leaf binds the returned 'ahp-remote-N' runtime instance.
    await host.activateAhpTerminalView(terminalUri, 'server-spawned', initialCols, initialRows, initialContent, undefined, ahpId);
  } else {
    await host.activateAhpTerminalView(terminalUri, 'server-spawned', initialCols, initialRows, initialContent);
  }
}

/**
 * Attach to an existing AHP session in interactive terminal mode. Subscribes to
 * the `ahp-terminal:` channel — which makes the server spawn (or resume) the pi
 * TUI if it isn't already running — and opens the view in PTY mode, replaying
 * the terminal snapshot (size + scrollback) so the prior screen is shown.
 *
 * Terminal mode is the ONLY attach mode: sessions are terminal-first. If the
 * terminal subscribe fails with -32000 (server has no node-pty), we report that
 * no interactive terminal is available rather than falling back to chat.
 *
 * Live-mirror (`external`) sessions trigger the one-time confirmation warning.
 * For older servers that omit `terminalMode`, the confirmation falls back to
 * the provider heuristic.
 */
export async function attachAhpSessionWithMode(
  host: AhpSessionHost,
  session: SessionSummary,
  options: {
    confirm?: (session: SessionSummary) => Promise<boolean>;
    notify?: (message: string, duration?: number) => void;
  } = {},
): Promise<void> {
  const client = host.ahpClient;
  if (!client) {
    (options.notify ?? ((m, d) => new Notice(m, d)))('AHP client not connected', 5000);
    return;
  }

  const confirm = options.confirm ?? ((s) => confirmLiveMirrorSession(host.app as App, s));
  const ok = await confirm(session);
  if (!ok) return;

  const displayName = session.title || session.resource;

  // Terminal mode only: subscribe to the interactive `ahp-terminal:` channel,
  // which makes the server spawn the pi TUI if it isn't already running (lazy
  // TerminalManager.ensureTerminal), and open the view replaying the snapshot.
  const terminalUri = session.resource.replace(/^ahp-session:/, 'ahp-terminal:');
  try {
    const snapshot = await client.subscribe(terminalUri);
    const { initialCols, initialRows, initialContent } = extractTerminalSnapshot(snapshot);
    const mode = session.terminalMode === 'external' ? 'external' : 'server-spawned';
    const ahpId = host.registerAhpInstance(displayName);
    if (ahpId) {
      // readOnly stays undefined; the id lands in the 7th slot (ahpInstanceId)
      // so the leaf binds the returned 'ahp-remote-N' runtime instance.
      await host.activateAhpTerminalView(terminalUri, mode, initialCols, initialRows, initialContent, undefined, ahpId);
    } else {
      await host.activateAhpTerminalView(terminalUri, mode, initialCols, initialRows, initialContent);
    }
    (options.notify ?? ((m, d) => new Notice(m, d)))(`✓ AHP interactive terminal: ${terminalUri}`, 4000);
  } catch (err) {
    const msg = errorMessage(err);
    if (isAhpError(err, -32000)) {
      // The server cannot provide a PTY (no node-pty, or the owning host's
      // local terminal is not running). Terminal is the only mode — do not
      // fall back to chat.
      (options.notify ?? ((m, d) => new Notice(m, d)))('AHP: no interactive terminal on this server', 6000);
      return;
    }
    if (isAhpError(err, -32002)) {
      // Session not found on the server — the catalogue entry is stale. Quiet
      // best-effort cleanup: forget the session server-side (no-op when it is
      // already gone) and report nothing noisy; the picker refreshes on its
      // own catalogue change subscription.
      try {
        await client.disposeSession(session.resource);
      } catch {
        /* best-effort — the session may already be gone or the ws is down */
      }
      return;
    }
    if (isAhpError(err, -32007)) {
      (options.notify ?? ((m, d) => new Notice(m, d)))(
        'AHP terminal rejected: authentication failed — check the server token in the pi plugin settings',
        8000,
      );
      return;
    }
    (options.notify ?? ((m, d) => new Notice(m, d)))(`AHP terminal subscribe failed: ${msg}`, 8000);
  }
}



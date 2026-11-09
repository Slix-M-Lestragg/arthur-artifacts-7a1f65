import { App, Modal, Setting } from 'obsidian';
import type { SessionSummary } from '../transport/AhpClient';
import { formatAgoIso } from '../instance/instancePresentation';

// Shared presentation helpers — the canonical implementations live in
// `../instance/instancePresentation` and `../transport/ahpStatus`; re-exported
// here under their historical names for existing consumers (and tests).
export { formatTokens } from '../instance/instancePresentation';
export { sessionStatusInfo } from '../transport/ahpStatus';
/** Coarse relative timestamp for the per-row activity line (ISO input). */
export const formatAgo = formatAgoIso;

/** Sentinel item representing the synthetic "+ New session" row. */
export const NEW_SESSION_ITEM = Object.freeze({ __new: true }) as { readonly __new: true };

/** Any item the unified picker can render: an existing session or the synthetic
 *  "+ New session" entry. */
export type UnifiedAhpItem = SessionSummary | typeof NEW_SESSION_ITEM;

/** Type guard for the synthetic "+ New session" item. */
export function isNewSessionItem(item: UnifiedAhpItem): item is typeof NEW_SESSION_ITEM {
  return item === NEW_SESSION_ITEM;
}

/** Fallback display name for sessions without a title. Mirrors the original
 *  picker so behavior stays consistent. */
export function sessionDisplayName(s: SessionSummary): string {
  return s.title?.trim() || '(untitled session)';
}

/** Compact working-directory label: last two path segments, prefixed with an
 *  ellipsis when the path is deeper. */
export function formatWorkingDirectory(uri?: string): string | undefined {
  if (!uri) return undefined;
  const raw = uri.replace(/^file:\/\//i, '');
  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  const sep = decoded.includes('/') ? '/' : decoded.includes('\\') ? '\\' : '/';
  const parts = decoded.split(sep).filter(Boolean);
  if (parts.length === 0) return undefined;
  const tail = parts.slice(-2).join('/');
  return parts.length > 2 ? `…/${tail}` : tail;
}

/** Status indicator for a session's currentAction. Returns a colored dot class
 *  + label, or undefined if the action isn't worth showing. (Moved to
 *  `../transport/ahpStatus` — re-exported above.) */

/** Type badge for a session: Hosted (user), Subagent, External, or Live-Mirror. */
export function sessionTypeBadgeRich(s: SessionSummary): { text: string; cls: string; title: string } | null {
  // External (host agent like Arthur)
  if (s.kind === 'external' || s.provider === 'external') {
    return { text: s.hostAgentName ? `External · ${s.hostAgentName}` : 'External', cls: 'pi-ahp-suggester-badge is-external', title: 'External session registered by a host agent' };
  }
  // Subagent (has a parent session)
  if (s.parentSessionUri) {
    return { text: 'Subagent', cls: 'pi-ahp-suggester-badge is-subagent', title: `Spawned by ${s.parentSessionUri}` };
  }
  // Live-mirror / relay
  if (isLiveMirrorSession(s)) {
    return { text: 'Live-Mirror', cls: 'pi-ahp-suggester-badge is-live-mirror', title: 'Live-Mirror (relay) session' };
  }
  // Archived (past session, read-only)
  if (s.kind === 'archive' || s.provider === 'archive') {
    return { text: 'Archived', cls: 'pi-ahp-suggester-badge is-archived', title: 'Archived pi session (read-only — no live terminal)' };
  }
  // Hosted (user-created)
  if (s.terminalMode === 'server-spawned' || s.kind === 'hosted' || s.provider === 'pi') {
    return { text: 'Hosted', cls: 'pi-ahp-suggester-badge is-hosted', title: 'Hosted pi session running on the AHP server' };
  }
  return null;
}

/**
 * Module-level set of live-mirror/relay session URIs the user has acknowledged
 * during the current plugin load. This intentionally resets when Obsidian (or
 * the plugin) reloads so the warning is reshown after a restart.
 */
const acknowledgedLiveMirrorUris = new Set<string>();

/**
 * Capability-aware live-mirror detection. When the server supplies an explicit
 * `terminalMode`, trust it: `external` means a live mirror of an externally
 * spawned terminal. For older servers that do not send `terminalMode`, fall
 * back to the provider heuristic so the warning still works.
 */
export function isLiveMirrorSession(s: SessionSummary): boolean {
  if (s.terminalMode === 'external') return true;
  if (s.terminalMode === 'server-spawned') return false;
  if (s.terminalMode === 'none') return false;
  return s.provider === 'pi-ahp-server' || !s.provider;
}

/**
 * If the chosen session is a live-mirror/relay session and has not yet been
 * acknowledged this vault load, show a one-time warning modal and return true
 * only if the user confirms. Non-live-mirror sessions pass through silently.
 */
export async function confirmLiveMirrorSession(
  app: App,
  session: SessionSummary,
): Promise<boolean> {
  if (!isLiveMirrorSession(session)) return true;
  if (acknowledgedLiveMirrorUris.has(session.resource)) return true;

  const confirmed = await confirmAction(
    app,
    'Live-Mirror session',
    'This is a live-mirror (relay) AHP session. Typing here can send input to the real local pi CLI process on the AHP server.\n\n' +
      'The server currently has no request authentication, so anyone with network access could also send input to it.\n\n' +
      'Attach only if you trust this session and the server.',
  );

  if (confirmed) acknowledgedLiveMirrorUris.add(session.resource);
  return confirmed;
}

/** Lightweight yes/no confirmation modal. */
class ConfirmModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly message: string,
    private readonly onDone: (confirmed: boolean | null) => void,
  ) {
    super(app);
    this.titleEl.setText(titleText);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.titleText });
    if (this.message) {
      for (const paragraph of this.message.split('\n\n')) {
        contentEl.createEl('p', { text: paragraph });
      }
    }

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText('Attach')
          .setCta()
          .onClick(() => {
            this.answered = true;
            this.close();
            this.onDone(true);
          }),
      )
      .addButton((b) =>
        b.setButtonText('Cancel').onClick(() => {
          this.answered = true;
          this.close();
          this.onDone(false);
        }),
      );
  }

  onClose(): void {
    if (!this.answered) this.onDone(null);
    this.contentEl.empty();
  }
}

/** Show a confirmation modal and return true if the user confirmed. */
function confirmAction(app: App, title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new ConfirmModal(app, title, message, (confirmed) => {
      resolve(confirmed === true);
    });
    modal.open();
  });
}

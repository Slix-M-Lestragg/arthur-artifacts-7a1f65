import { App, Modal, Notice } from 'obsidian';
import type { SessionSummary } from '../transport/AhpClient';
import { formatAgoIso, formatTokens } from '../instance/instancePresentation';
import { sessionStatusInfo } from '../transport/ahpStatus';
import { matchLocalRelaySession } from '../transport/localRelay';
import {
  NEW_SESSION_ITEM,
  type UnifiedAhpItem,
  isNewSessionItem,
  sessionDisplayName,
  formatWorkingDirectory,
  sessionTypeBadgeRich,
  isLiveMirrorSession,
} from './AhpSessionPickerModal';

/**
 * Custom card-based session browser (replaces the FuzzySuggestModal picker).
 *
 * Renders a scrollable card list grouped into "Live" (hosted + external) and
 * "Archived" sections, with a search filter, status dots, type badges, and a
 * full metadata row (model · tokens · turns · cost · cwd · size · age). Clicking
 * a card opens the session (live) or shows a read-only notice (archived).
 */
export class AhpSessionBrowserModal extends Modal {
  private readonly items: UnifiedAhpItem[];
  private readonly onChooseSession: (session: SessionSummary) => void;
  private readonly onNewSession: () => void;
  /** This device's host-agent name — own-device external rows get a 'local' badge. */
  private readonly localDeviceName: string;
  private listEl!: HTMLElement;
  private searchQuery = '';

  constructor(
    app: App,
    sessions: SessionSummary[],
    onChooseSession: (session: SessionSummary) => void,
    onNewSession: () => void = () => {},
    localDeviceName: string = '',
  ) {
    super(app);
    this.items = [NEW_SESSION_ITEM, ...sessions];
    this.onChooseSession = onChooseSession;
    this.onNewSession = onNewSession;
    this.localDeviceName = (localDeviceName || 'Voyager').trim();
    this.setTitle('AHP sessions');
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    contentEl.empty();
    contentEl.addClass('pi-ahp-browser');

    // Header: title + search input
    const headerEl = contentEl.createDiv({ cls: 'pi-ahp-browser-header' });
    const searchEl = headerEl.createEl('input', {
      type: 'search',
      placeholder: 'Search sessions…',
      cls: 'pi-ahp-browser-search',
    });
    searchEl.addEventListener('input', () => {
      this.searchQuery = searchEl.value.toLowerCase().trim();
      this.renderList();
    });

    // Scrollable card list
    this.listEl = contentEl.createDiv({ cls: 'pi-ahp-browser-list' });
    this.renderList();

    // Focus the search for immediate typing
    setTimeout(() => searchEl.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderList(): void {
    const { listEl } = this;
    listEl.empty();

    // "+ New session" card (always first, not filtered)
    this.renderNewCard(listEl);

    // Filter live + archived sessions
    const live = this.items.filter(
      (i): i is SessionSummary => !isNewSessionItem(i) && i.kind !== 'archive' && i.kind !== 'relay',
    );
    const archived = this.items.filter(
      (i): i is SessionSummary => !isNewSessionItem(i) && i.kind === 'archive',
    );

    const filteredLive = this.filterSessions(live);
    const filteredArchived = this.filterSessions(archived);

    if (filteredLive.length > 0) {
      this.renderSection(listEl, 'Live sessions', filteredLive);
    }
    if (filteredArchived.length > 0) {
      this.renderSection(listEl, `Archived (${filteredArchived.length})`, filteredArchived);
    }
    if (filteredLive.length === 0 && filteredArchived.length === 0) {
      listEl.createEl('div', { text: 'No sessions match your search.', cls: 'pi-ahp-browser-empty' });
    }
  }

  private filterSessions(sessions: SessionSummary[]): SessionSummary[] {
    if (!this.searchQuery) return sessions;
    const q = this.searchQuery;
    return sessions.filter((s) => {
      const haystack = [s.title, s.resource, s.model, formatWorkingDirectory(s.workingDirectory), s.hostAgentName, s.provider]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  private renderSection(parent: HTMLElement, label: string, sessions: SessionSummary[]): void {
    const sectionEl = parent.createDiv({ cls: 'pi-ahp-browser-section' });
    sectionEl.createEl('div', { text: label, cls: 'pi-ahp-browser-section-label' });
    for (const s of sessions) {
      this.renderSessionCard(sectionEl, s);
    }
  }

  private renderNewCard(parent: HTMLElement): void {
    const cardEl = parent.createDiv({ cls: 'pi-ahp-browser-card is-new' });
    const rowEl = cardEl.createDiv({ cls: 'pi-ahp-browser-card-row' });
    rowEl.createEl('span', { text: '+', cls: 'pi-ahp-browser-new-icon' });
    rowEl.createEl('span', { text: 'New session', cls: 'pi-ahp-browser-card-title' });
    cardEl.createEl('small', {
      text: 'Create a new hosted pi session on the AHP server',
      cls: 'pi-ahp-browser-card-meta',
    });
    cardEl.addEventListener('click', () => {
      this.onNewSession();
      this.close();
    });
  }

  private renderSessionCard(parent: HTMLElement, s: SessionSummary): void {
    const isArchive = s.kind === 'archive' || s.provider === 'archive';
    const cardEl = parent.createDiv({ cls: `pi-ahp-browser-card${isArchive ? ' is-archive' : ''}` });
    if (s.parentSessionUri) cardEl.addClass('is-subagent');

    // Row 1: status dot + title + badges
    const rowEl = cardEl.createDiv({ cls: 'pi-ahp-browser-card-row' });

    const status = sessionStatusInfo(s);
    if (status) {
      rowEl.createEl('span', { cls: `pi-ahp-dot ${status.dotCls}`, title: status.label });
    } else if (s.kind === 'external' && s.hostOnline === false) {
      rowEl.createEl('span', { cls: 'pi-ahp-dot pi-ahp-dot-offline', title: 'host offline' });
    } else if (isArchive) {
      rowEl.createEl('span', { cls: 'pi-ahp-browser-archive-icon', text: '⏚' });
    } else {
      rowEl.createEl('span', { cls: 'pi-ahp-dot pi-ahp-dot-idle' });
    }

    const titleSpan = rowEl.createEl('span', { text: sessionDisplayName(s), cls: 'pi-ahp-browser-card-title' });
    titleSpan.setAttribute('title', s.resource);

    const badge = sessionTypeBadgeRich(s);
    if (badge) {
      rowEl.createEl('span', { text: badge.text, cls: badge.cls, title: badge.title });
    }
    if (s.paused) {
      rowEl.createEl('span', { text: 'paused', cls: 'pi-ahp-suggester-badge is-paused', title: 'Paused' });
    }
    // Prefer-local badge (AUDIT FIX SLICE H): an external row published by
    // THIS device's host agent will open the local PTY terminal (with resume)
    // instead of relaying through the broker — mark it so it isn't mistaken
    // for a true remote session. Mirrors FarmView's pi-farm-local-mirror-badge.
    if (this.localDeviceName && matchLocalRelaySession(s, this.localDeviceName)) {
      rowEl.createEl('span', {
        text: 'local',
        cls: 'pi-ahp-suggester-badge is-local',
        title: 'Runs on this device — opens the local terminal',
      });
    }

    // Row 2: metadata
    const metaParts: string[] = [];
    if (s.model) metaParts.push(s.model);
    const tokIn = formatTokens(s.tokensIn);
    const tokOut = formatTokens(s.tokensOut);
    if (tokIn && tokOut) metaParts.push(`${tokIn}↓ ${tokOut}↑`);
    else if (tokIn) metaParts.push(`${tokIn}↓`);
    if (s.turns && s.turns > 0) metaParts.push(`${s.turns} turn${s.turns === 1 ? '' : 's'}`);
    if (s.cost !== undefined && s.cost > 0) metaParts.push(`$${s.cost.toFixed(2)}`);
    const cwd = formatWorkingDirectory(s.workingDirectory);
    if (cwd) metaParts.push(cwd);
    if (s.hostAgentName) metaParts.push(`@${s.hostAgentName}`);
    const sizeBytes = (s._meta as { sizeBytes?: number } | undefined)?.sizeBytes;
    if (sizeBytes && sizeBytes > 0) {
      metaParts.push(sizeBytes < 1024 ? `${sizeBytes}B` : sizeBytes < 1_048_576 ? `${Math.round(sizeBytes / 1024)}KB` : `${(sizeBytes / 1_048_576).toFixed(1)}MB`);
    }
    const ago = formatAgoIso(s.modifiedAt);
    if (ago) metaParts.push(ago);
    if (metaParts.length > 0) {
      cardEl.createEl('small', { text: metaParts.join('  ·  '), cls: 'pi-ahp-browser-card-meta' });
    }

    // Click → open (live) or notice (archive)
    cardEl.addEventListener('click', () => {
      if (isArchive) {
        const meta = s._meta as Record<string, unknown> | undefined;
        new Notice(`Archived session (read-only): ${sessionDisplayName(s)}${meta?.channel ? `\nChannel: ${meta.channel}` : ''}`, 6000);
        return;
      }
      this.onChooseSession(s);
      this.close();
    });
  }
}

// Re-export so callers can swap seamlessly from the fuzzy picker
export { isLiveMirrorSession };
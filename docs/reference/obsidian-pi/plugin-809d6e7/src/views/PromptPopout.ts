/**
 * PromptPopout — the floating Obsidian markdown prompt editor.
 *
 * Opens the scratch prompt note either as a **popout OS window** (frameless,
 * chrome-stripped, with a compact draggable header) or **docked in the main
 * Obsidian window** (a normal leaf). Because it's a genuine MarkdownView, the
 * user gets Live Preview rendering, native [[wikilink]] autocomplete, image
 * paste, and the Reading-view toggle — the "full Obsidian markdown writing
 * experience".
 *
 * Submitting reads the live editor text and pushes it to pi through the PTY via
 * a custom APC marker (see PtyClient.submitPrompt / obsidian-bridge.ts). ⌘/Ctrl+Enter
 * submits from either surface.
 */

import { App, FuzzySuggestModal, MarkdownView, Menu, Notice, TFile, WorkspaceLeaf, WorkspaceWindow, EventRef, setIcon } from 'obsidian';
import type ObsidianPiPlugin from '../main';
import { instancePromptNotePath, getPluginBasePaths } from '../instance/InstancePaths';
import {
  isImageFile,
  listImageFiles,
  pasteEventHasImage,
  readClipboardImage,
  vaultPathToAbsolute,
  writeClipboardImageToTemp,
  writeImageToTemp,
} from '../utils/imageAttach';
import { mediaRecorderSupported } from '../utils/stt';
import { MicStreamer } from '../utils/stt-stream';
import type { PiInstance } from '../instance/InstanceManager';
import type { PtyClient } from '../transport/PtyClient';
import type { TerminalView } from './TerminalView';
import { openCommandPicker } from './CommandPickerModal';
import { CmEditorAdapter } from './suggest/CmEditorAdapter';
import { FileAtSuggester } from './suggest/FileAtSuggester';

/** Chrome-stripping CSS injected into the popout document (self-contained / guaranteed-scoped). */
const PROMPT_POPOUT_CSS = `
body.pi-prompt-popout { overflow: hidden; display: flex; flex-direction: column; }

/* Compact, modern draggable header — acts as the window grab bar (Electron drag
   region). In the popout this single row also hosts the action-toolbar buttons
   and the pin/dock/close window controls, with left padding on macOS to clear
   the native traffic-light buttons. */
.pi-prompt-header {
  flex: 0 0 38px;
  height: 38px;
  display: flex; align-items: center; gap: 4px;
  padding: 0 6px 0 10px;
  background: var(--background-secondary);
  border-bottom: 1px solid var(--background-modifier-border);
  color: var(--text-muted);
  font-size: 11px;
  user-select: none;
  z-index: 100;
  overflow: hidden;
}
.pi-prompt-header-title { font-weight: 600; letter-spacing: .02em; white-space: nowrap; }
.pi-prompt-header-grip { opacity: .45; letter-spacing: -3px; }
.pi-prompt-header-spacer { flex: 1 1 auto; }
.pi-prompt-header-hint { font-size: 10px; opacity: .6; white-space: nowrap; }
.pi-prompt-header-btn {
  -webkit-app-region: no-drag;
  height: 28px; min-width: 28px; padding: 0 6px;
  border: none; border-radius: 6px;
  background: transparent; color: var(--text-muted); cursor: pointer;
  font-size: 13px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
}
.pi-prompt-header-btn:hover { background: var(--background-modifier-hover); color: var(--text-normal); }
.pi-prompt-header-btn.is-active { background: var(--background-modifier-hover); color: var(--text-accent); }
/* The header is a window-drag region only in the floating popout — the docked
   pane lives in the main Obsidian window and must not drag it. */
body.pi-prompt-popout .pi-prompt-header { -webkit-app-region: drag; }
body.pi-prompt-popout .pi-prompt-header .pi-prompt-actionbar-btn { -webkit-app-region: no-drag; }
body.pi-prompt-mac .pi-prompt-header { padding-left: 78px; }

/* Action toolbar — a compact row of prompt-composing buttons, shown in both
   the floating popout (below the drag header) and the docked pane (above the
   markdown editor). Same markup/CSS in both surfaces. */
.pi-prompt-actionbar {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 2px;
  padding: 5px 8px;
  background: var(--background-secondary);
  border-bottom: 1px solid var(--background-modifier-border);
  z-index: 99;
  user-select: none;
}
body.pi-prompt-popout .pi-prompt-actionbar { -webkit-app-region: no-drag; }
.pi-prompt-actionbar-btn {
  height: 28px; min-width: 28px; padding: 0 6px;
  border: none; border-radius: 6px;
  background: transparent; color: var(--text-muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 4px;
  font-size: 11px; line-height: 1;
}
.pi-prompt-actionbar-btn svg { width: 16px; height: 16px; }
.pi-prompt-actionbar-btn:hover { background: var(--background-modifier-hover); color: var(--text-normal); }
.pi-prompt-actionbar-btn.is-active { background: var(--interactive-accent); color: var(--text-on-accent); }
.pi-prompt-actionbar-btn:disabled { opacity: .4; cursor: default; }
.pi-prompt-actionbar-sep { width: 1px; height: 20px; background: var(--background-modifier-border); margin: 0 4px; flex: 0 0 auto; }
.pi-prompt-actionbar-spacer { flex: 1 1 auto; }
.pi-prompt-actionbar-stats { font-size: 11px; color: var(--text-muted); white-space: nowrap; padding: 0 6px; }

/* Workspace fills the space below the header. */
body.pi-prompt-popout .workspace,
body.pi-prompt-popout .app-container { flex: 1 1 auto; min-height: 0; height: auto !important; }
body.pi-prompt-popout .workspace-tab-header-container { display: none !important; }
body.pi-prompt-popout .view-header { display: none !important; }
body.pi-prompt-popout .workspace-split,
body.pi-prompt-popout .workspace-tabs,
body.pi-prompt-popout .workspace-leaf,
body.pi-prompt-popout .workspace-leaf-content { background: transparent; }
body.pi-prompt-popout .workspace-split.mod-root { padding: 0 !important; }
body.pi-prompt-popout .workspace-tab-container { padding: 0 !important; }
body.pi-prompt-popout .markdown-source-view,
body.pi-prompt-popout .markdown-reading-view,
.pi-prompt-docked .markdown-source-view,
.pi-prompt-docked .markdown-reading-view { padding: 8px 12px; }
body.pi-prompt-popout .markdown-source-view .cm-scroller { padding-top: 4px; }
/* Kill Obsidian's readable-line-length centering so prompt text flows near
   edge-to-edge instead of being boxed into a narrow centered column. */
body.pi-prompt-popout .cm-sizer,
body.pi-prompt-popout .cm-contentContainer,
body.pi-prompt-popout .markdown-preview-sizer,
.pi-prompt-docked .cm-sizer,
.pi-prompt-docked .cm-contentContainer,
.pi-prompt-docked .markdown-preview-sizer {
  max-width: none !important;
  margin: 0 !important;
  padding-right: 0 !important;
}
body.pi-prompt-popout .workspace-split.mod-left,
body.pi-prompt-popout .workspace-split.mod-right,
body.pi-prompt-popout .workspace-ribbon,
body.pi-prompt-popout .sidebar { display: none !important; }
`;

/** Layout CSS for the DOCKED prompt editor: lays the pane out as a column so
 * the merged `.pi-prompt-header` sits above the markdown view, which fills the
 * remaining space. Injected into the main document (scoped to
 * `.pi-prompt-docked`, added to the MarkdownView content element). */
const PROMPT_DOCKED_CSS = `
.pi-prompt-docked { display: flex; flex-direction: column; }
.pi-prompt-docked .pi-prompt-header { flex: 0 0 auto; }
.pi-prompt-docked .markdown-source-view,
.pi-prompt-docked .markdown-reading-view { flex: 1 1 auto; min-height: 0; }
`;

function fontRule(scope: string, px: number): string {
  return scope + ' .cm-content,' + scope + ' .cm-line,' + scope +
    ' .markdown-reading-view{font-size:' + px + 'px !important}';
}

export class PromptPopout {
  private readonly app: App;
  private readonly plugin: ObsidianPiPlugin;

  /** The pi instance this prompt popout belongs to (Phase 10). */
  readonly instanceId: string;

  /** This instance's prompt note path (legacy path for the default instance). */
  get promptNotePath(): string {
    const config = this.plugin.settings.instances.find((i) => i.id === this.instanceId);
    return instancePromptNotePath(
      this.plugin,
      config ?? { id: this.instanceId, name: this.instanceId, cwd: '' },
    );
  }

  /** Popout-window leaf (when surface = popout). */
  private leaf: WorkspaceLeaf | null = null;
  /** Docked main-window leaf (when surface = docked). */
  private dockedLeaf: WorkspaceLeaf | null = null;
  /** Embedded leaf mounted inside the terminal view (when surface = embedded). */
  private embeddedLeaf: WorkspaceLeaf | null = null;
  private currentSurface: 'popout' | 'docked' | 'embedded' | null = null;

  private win: Window | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private fontStyleEl: HTMLStyleElement | null = null;
  private headerEl: HTMLElement | null = null;
  private closeRef: EventRef | null = null;
  private keydownWin: Window | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  /** Main-window keydown handler used while docked or embedded. */
  private dockKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private dockedFontStyleEl: HTMLStyleElement | null = null;
  private embeddedFontStyleEl: HTMLStyleElement | null = null;
  /** Re-applies the docked tab icon on layout changes (Obsidian resets it on re-render). */
  private dockedIconLayoutRef: EventRef | null = null;
  private dockedIconRaf: number | null = null;
  /** Merged header element shown at the top of the docked prompt editor
   * (same `.pi-prompt-header` markup as the floating popout). */
  private dockedHeaderEl: HTMLElement | null = null;
  /** Injected docked-layout `<style>` (column layout for the merged header). */
  private dockedLayoutStyleEl: HTMLStyleElement | null = null;
  /** Load-time cleanup poll that detaches stale restored prompt-note leaves. */
  private freshInterval: number | null = null;
  /** Event refs for the load-time workspace event listeners (window-open / layout-change). */
  private loadEventRefs: EventRef[] = [];

  // Phase 9b lifecycle instrumentation. Gated behind a debug flag so production
  // is silent; flip LIFECYCLE_DEBUG to true to re-enable tracing.
  private static readonly LIFECYCLE_DEBUG = false;
  private logLifecycle(msg: string, ...args: unknown[]): void {
    if (!PromptPopout.LIFECYCLE_DEBUG) return;
    console.log(`[pi-prompt-lifecycle] ${msg}`, ...args);
  }

  private lastSubmitAt = 0;
  /** The question_user panel (options list) — rendered above the editor when the
   *  terminal has a pending question. Polled every 1s while the popout is open. */
  private questionPanelEl: HTMLElement | null = null;
  private lastQuestionId: string | null = null;
  private alwaysOnTop = false;
  private alwaysOnTopBtn: HTMLButtonElement | null = null;

  // ── Action toolbar (shared by popout + docked) ──────────────────────────
  /** Live word/char-count readout span (in whichever toolbar is active). */
  private statsEl: HTMLElement | null = null;
  /** Toggle button for the stats readout. */
  private statsBtn: HTMLButtonElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  /** Surface switcher button. */
  private surfaceBtn: HTMLButtonElement | null = null;
  /** Real-time streaming dictation client. */
  private mic: MicStreamer | null = null;
  /** Voice-dictation toolbar button. */
  private micBtn: HTMLElement | null = null;
  /** Editor offset where the current dictation draft starts. */
  private micAnchor = 0;
  /** Length of the current dictation draft (so the next update overwrites it). */
  private micPrevLen = 0;
  /** Live audio-spectrum meter canvas shown while dictating. */
  private meterCanvas: HTMLCanvasElement | null = null;
  /** Polling interval driving the live stats readout. */
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  /** Persistent layout-change listener that detaches duplicate prompt-note leaves
   * whenever the editor is wired — catches late-restored or stray duplicates
   * beyond the load grace window (Phase 9b). */
  private dupGuardRef: EventRef | null = null;
  /** Trailing debounce timer for the duplicate guard (avoids a full leaf scan
   * on every rapid layout-change event, which causes forced reflows). */
  private dupGuardTimer: number | null = null;

  /** @-file-reference suggester wired to the active prompt editor. */
  private fileAtSuggester: FileAtSuggester | null = null;
  /** Capture-phase paste interceptor that turns image pastes into `@/tmp/...` mentions. */
  private pasteImageHandler: { target: HTMLElement; handler: (e: ClipboardEvent) => void } | null = null;

  constructor(app: App, plugin: ObsidianPiPlugin, instanceId: string) {
    this.app = app;
    this.plugin = plugin;
    this.instanceId = instanceId;
    this.registerDuplicateGuard();
  }

  /** Runtime object for this popout's instance. */
  private getInstance(): PiInstance {
    return this.plugin.instanceManager.getOrCreate(this.instanceId);
  }

  /** This instance's PTY client, if any. */
  private getPtyClient(): PtyClient | null {
    return this.getInstance().ptyClient;
  }

  /** This instance's terminal view, if any. */
  private getTerminalView(): TerminalView | null {
    const inst = this.getInstance();
    if (inst.terminalView) return inst.terminalView;
    // Fallback: the instance's terminalView may be null (not yet booted, or a
    // stale reference after reload). Search the workspace for the active AHP
    // terminal view so the prompt editor connects even without the instance ref.
    let found: TerminalView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const view = leaf.view;
      if (view && typeof (view as any).isAhp === 'function' && (view as any).isAhp()) found = view as TerminalView;
    });
    return found;
  }

  /**
   * Register a plugin-lifetime layout-change listener that, whenever the
   * prompt editor is wired, detaches any other prompt-note leaf that appears
   * (late-restored popouts, stray duplicates). A no-op when the editor isn't
   * open. This complements the transient ensureFreshOnLoad poll so duplicates
   * are caught at any time, not just during the first ~3s after load.
   */
  private registerDuplicateGuard(): void {
    if (this.dupGuardRef) return;
    this.dupGuardRef = this.app.workspace.on('layout-change', () => {
      if (!this.leaf && !this.dockedLeaf && !this.embeddedLeaf) return;
      // Debounce: layout-change fires very frequently (resizes, focus, etc.),
      // and each scan is a full iterateAllLeaves + DOM reads (forced reflow).
      // Coalesce bursts into a single trailing scan after ~300ms of quiet.
      if (this.dupGuardTimer != null) window.clearTimeout(this.dupGuardTimer);
      this.dupGuardTimer = window.setTimeout(() => {
        this.dupGuardTimer = null;
        if (!this.leaf && !this.dockedLeaf && !this.embeddedLeaf) return;
        // Defer the heavy full-leaf scan to an idle period; fall back to a
        // short timeout so we still catch duplicates quickly on busy frames.
        const runScan = () => {
          if (!this.leaf && !this.dockedLeaf && !this.embeddedLeaf) return;
          this.detachDuplicatePromptLeaves();
          if (this.leaf) this.cleanupOrphanPromptWindows();
        };
        const ric = (window as any).requestIdleCallback;
        if (ric) {
          ric(runScan, { timeout: 200 });
        } else {
          window.setTimeout(runScan, 0);
        }
      }, 300);
    });
    // Auto-clean on plugin unload via the plugin's event registry.
    this.plugin.registerEvent(this.dupGuardRef);
  }

  get isOpen(): boolean { return this.leaf != null || this.dockedLeaf != null || this.embeddedLeaf != null; }
  get isPopout(): boolean { return this.leaf != null; }
  get isDocked(): boolean { return this.dockedLeaf != null; }
  get isEmbedded(): boolean { return this.embeddedLeaf != null; }

  // ─── Open ──────────────────────────────────────────────────────────────────

  /** Open in the configured surface (plugin setting). */
  async open(): Promise<void> {
    this.logLifecycle('open() start', { leaf: !!this.leaf, dockedLeaf: !!this.dockedLeaf, embeddedLeaf: !!this.embeddedLeaf });
    if (this.leaf) { this.win?.focus(); return; }
    if (this.dockedLeaf) { this.app.workspace.revealLeaf(this.dockedLeaf); return; }
    if (this.embeddedLeaf) { this.getTerminalView()?.togglePromptPanel(); return; }
    // Reuse an already-open markdown leaf for the prompt note (e.g. one that
    // Obsidian restored as part of the workspace on restart) instead of
    // spawning a duplicate popout/docked/embedded pane (Phase 9).
    if (await this.adoptExisting()) {
      this.logLifecycle('open() adopted existing');
      return;
    }
    this.logLifecycle('open() no existing → spawning fresh surface', this.plugin.settings.promptSurface);
    if (this.plugin.settings.promptSurface === 'embedded') {
      await this.openEmbedded();
    } else if (this.plugin.settings.promptSurface === 'docked') {
      await this.openDocked();
    } else {
      await this.openPopout();
    }
  }

  /**
   * Find and adopt an already-open markdown leaf showing the prompt note (e.g.
   * one Obsidian restored as part of the workspace on restart) — wiring it to
   * the TUI (merged header + ⌘/Ctrl+Enter submit) without spawning a duplicate.
   * Returns true if a leaf was adopted (or already wired), false if none open.
   * Safe to call on every load: a no-op when the prompt note isn't open.
   */
  async adoptExisting(): Promise<boolean> {
    this.logLifecycle('adoptExisting() start', { leaf: !!this.leaf, dockedLeaf: !!this.dockedLeaf, embeddedLeaf: !!this.embeddedLeaf });
    if (this.leaf || this.dockedLeaf || this.embeddedLeaf) return true;
    const existing = this.findExistingPromptLeaf();
    this.logLifecycle('adoptExisting() findExistingPromptLeaf', existing ? { leafId: (existing.leaf as any).id, isPopout: existing.isPopout, filePath: (existing.leaf.view as MarkdownView)?.file?.path } : null);
    if (!existing) return false;

    // findExistingPromptLeaf() is scoped to THIS instance's note path, so any
    // leaf it returns already belongs to us — no cross-instance routing.
    if (existing.isPopout) {
      await this.adoptPopoutLeaf(existing.leaf);
    } else if (this.plugin.settings.promptSurface === 'embedded') {
      await this.adoptEmbeddedLeaf(existing.leaf);
      // After mounting, the wired embedded leaf is recognized so duplicates can be pruned.
      this.detachDuplicatePromptLeaves();
    } else {
      await this.adoptDockedLeaf(existing.leaf);
    }
    this.logLifecycle('adoptExisting() adopted', { leaf: !!this.leaf, dockedLeaf: !!this.dockedLeaf, embeddedLeaf: !!this.embeddedLeaf });
    return true;
  }

  /**
   * Detach any open markdown leaf showing the prompt note that ISN'T the wired
   * editor — i.e. a true duplicate. Must only be called after adoption has
   * already wired this.leaf/this.dockedLeaf, or immediately before spawning a
   * fresh editor when no adoption succeeded (to clear zombie leaves).
   */
  private detachDuplicatePromptLeaves(): void {
    const notePath = this.promptNotePath;
    this.logLifecycle('detachDuplicatePromptLeaves() start', { notePath, leaf: (this.leaf as any)?.id, dockedLeaf: (this.dockedLeaf as any)?.id });
    if (!notePath) return;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf === this.leaf || leaf === this.dockedLeaf || leaf === this.embeddedLeaf) return; // keep the wired one
      const view = leaf.view;
      const matches = view instanceof MarkdownView && view.file && view.file.path === notePath;
      if (!matches) return;
      const leafWin = leaf.view.containerEl.ownerDocument.defaultView;
      const isPopout = leafWin != null && leafWin !== window;
      if (isPopout && !this.isPopoutLeafReady(leaf)) {
        this.logLifecycle('detachDuplicatePromptLeaves() deferring detach — popout leaf not ready', { leafId: (leaf as any).id });
        return;
      }
      this.logLifecycle('detachDuplicatePromptLeaves() detaching leaf', { leafId: (leaf as any).id, filePath: view.file?.path, isPopout, winReady: isPopout ? this.isPopoutLeafReady(leaf) : true });
      try { leaf.detach(); } catch (err) { this.logLifecycle('detachDuplicatePromptLeaves() detach error', (leaf as any).id, err); }
    });
  }

  /**
   * On load, guarantee a single prompt editor. Events are the primary
   * detection mechanism (workspace 'window-open' and 'layout-change'); a short
   * interval remains as a conservative fallback for environments where events
   * are delayed or don't fire for all restore paths. On every pass we FIRST try
   * to adopt any restored prompt-note leaf, THEN detach only true duplicates.
   * Only if nothing is adopted after the grace window do we spawn fresh.
   */
  ensureFreshOnLoad(spawnIfNone: boolean): void {
    this.logLifecycle('ensureFreshOnLoad() start', { spawnIfNone, leaf: !!this.leaf, dockedLeaf: !!this.dockedLeaf, embeddedLeaf: !!this.embeddedLeaf });
    if (this.leaf || this.dockedLeaf || this.embeddedLeaf) return;
    this.stopFreshOnLoad();
    let ticks = 0;
    let spawnDone = !spawnIfNone;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        ticks++;
        this.logLifecycle('ensureFreshOnLoad() tick', { ticks, spawnDone, leaf: !!this.leaf, dockedLeaf: !!this.dockedLeaf, embeddedLeaf: !!this.embeddedLeaf });

        // Phase 9b: adopt BEFORE any detach. Try every tick so a restored popout
        // that appears mid-poll is adopted immediately instead of being
        // mistaken for a stale duplicate.
        const adopted = await this.adoptExisting();
        if (adopted) {
          // One duplicate sweep, then stop polling — the persistent duplicate
          // guard handles anything that appears later. Avoids 3s of redundant
          // full-leaf scans (forced reflows) after a successful adoption.
          this.detachDuplicatePromptLeaves();
          this.stopFreshOnLoad();
          return;
        }

        // Grace window expired and still no wired leaf → spawn fresh.
        if (!spawnDone && ticks >= 6 && !(this.leaf || this.dockedLeaf || this.embeddedLeaf)) {
          spawnDone = true;
          this.logLifecycle('ensureFreshOnLoad() grace expired → final adopt check then spawn');
          await this.adoptExisting(); // one last check in case leaf appeared since last tick
          if (!(this.leaf || this.dockedLeaf || this.embeddedLeaf)) {
            // Clean any zombie prompt-note leaves before spawning, then open.
            this.detachDuplicatePromptLeaves();
            void this.open();
          }
        }

        if (ticks >= 12) {
          this.logLifecycle('ensureFreshOnLoad() stopping poll');
          this.stopFreshOnLoad();
        }
      } finally {
        running = false;
      }
    };

    // React immediately when a popout window opens or the workspace mutates.
    // These are temporary load-time listeners; we manage their lifecycle
    // manually in stopFreshOnLoad() rather than via plugin.registerEvent().
    const onWindowOpen = this.app.workspace.on('window-open', () => {
      this.logLifecycle('ensureFreshOnLoad() window-open event');
      void tick();
    });
    const onLayoutChange = this.app.workspace.on('layout-change', () => {
      this.logLifecycle('ensureFreshOnLoad() layout-change event');
      void tick();
    });
    this.loadEventRefs = [onWindowOpen, onLayoutChange];

    // Immediate first pass, then repeat every 250ms for the grace window.
    void tick();
    this.freshInterval = window.setInterval(() => { void tick(); }, 400);
  }

  private stopFreshOnLoad(): void {
    if (this.freshInterval != null) {
      window.clearInterval(this.freshInterval);
      this.freshInterval = null;
    }
    for (const ref of this.loadEventRefs) {
      try { this.app.workspace.offref(ref); } catch { /* gone */ }
    }
    this.loadEventRefs = [];
  }

  /**
   * Scan all open markdown leaves (across the main window and every popout)
   * for one whose file matches THIS instance's prompt note path — so each
   * instance only adopts its own restored leaf and never short-circuits onto
   * another instance's already-open editor (which previously made the second
   * terminal's 'open floating prompt' a silent no-op).
   */
  private findExistingPromptLeaf(): { leaf: WorkspaceLeaf; isPopout: boolean } | null {
    const notePath = this.promptNotePath;
    if (!notePath) return null;
    let scanned = 0;
    // Using an array avoids TypeScript's closure-capture narrowing of a nullable
    // `let` binding; we only keep the first match.
    const matches: { leaf: WorkspaceLeaf; isPopout: boolean }[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      scanned++;
      if (matches.length) return;
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && view.file.path === notePath) {
        const leafWin = leaf.view.containerEl.ownerDocument.defaultView;
        const isPopout = leafWin != null && leafWin !== window;
        matches.push({ leaf, isPopout });
      }
    });
    const found = matches[0] ?? null;
    this.logLifecycle('findExistingPromptLeaf()', { notePath, scanned, found: found ? { leafId: (found.leaf as any).id, isPopout: found.isPopout } : null });
    return found;
  }

  /** True if a popout leaf's DOM/window looks fully initialized (avoid detaching a half-created popout, which can leave a zombie OS window). */
  private isPopoutLeafReady(leaf: WorkspaceLeaf): boolean {
    const win = leaf.view.containerEl.ownerDocument.defaultView;
    if (!win || win === window) return false;
    return leaf.view.containerEl.isConnected;
  }

  /**
   * Close any orphan Electron popout BrowserWindow whose title matches the
   * prompt note but which Obsidian no longer tracks — a zombie left over from a
   * prior session where a half-initialized popout was detached without closing
   * its OS window. The currently-wired popout and the main window are always
   * preserved. Best-effort: silently no-ops when Electron remote is unavailable.
   */
  private cleanupOrphanPromptWindows(): void {
    try {
      const remoteAny: any = (typeof require === 'function')
        ? (() => { try { return require('@electron/remote'); } catch { try { return require('electron').remote; } catch { return null; } } })()
        : null;
      if (!remoteAny) return;
      const BrowserWindow: any = remoteAny.BrowserWindow;
      if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return;
      const all: any[] = BrowserWindow.getAllWindows() ?? [];
      let mainBW: any = null;
      try { mainBW = remoteAny.getCurrentWindow?.(); } catch { /* ignore */ }

      // Phase 10: consider every instance's prompt note title, and preserve
      // any popout that an instance's PromptPopout has adopted.
      const promptTitles = new Set<string>();
      const adoptedBwIds = new Set<number>();
      for (const cfg of this.plugin.settings.instances) {
        const p = instancePromptNotePath(this.plugin, cfg);
        if (p) promptTitles.add((p.split('/').pop() ?? '').replace(/\.md$/i, '').toLowerCase());
        const popout = this.plugin.instanceManager.get(cfg.id)?.promptPopout;
        if (!popout) continue;
        try {
          const bw = popout.getPopoutBrowserWindow();
          if (bw?.id != null) adoptedBwIds.add(bw.id);
        } catch { /* ignore */ }
      }
      if (!promptTitles.size) return;
      let closed = 0;
      for (const bw of all) {
        if (!bw) continue;
        if (mainBW && bw.id === mainBW.id) continue;
        if (adoptedBwIds.has(bw.id)) continue;
        let title = '';
        try { title = (bw.getTitle?.() ?? '').toLowerCase(); } catch { /* ignore */ }
        // Exact title (or "<title> - …" window-chrome suffix) only — a substring
        // match could close an unrelated popout whose note title merely
        // contains a prompt note's name.
        const titleMatches = promptTitles.has(title) || Array.from(promptTitles).some((t) => title.startsWith(t + ' - '));
        if (titleMatches) {
          this.logLifecycle('cleanupOrphanPromptWindows() closing orphan', { id: bw.id, title });
          try { bw.close(); closed++; } catch (err) { this.logLifecycle('cleanupOrphanPromptWindows() close error', err); }
        }
      }
      if (closed) this.logLifecycle('cleanupOrphanPromptWindows() closed count', closed);
    } catch (err) {
      this.logLifecycle('cleanupOrphanPromptWindows() error', err);
    }
  }

  /** Adopt an already-open main-window leaf as the docked prompt editor. */
  private async adoptDockedLeaf(leaf: WorkspaceLeaf): Promise<void> {
    this.dockedLeaf = leaf;
    const view = leaf.view;
    if (view instanceof MarkdownView) {
      view.contentEl.addClass('pi-prompt-docked');
    }
    // Swap the tab icon to match the terminal view's prompt-editor button
    // (squircle). Applied via a layout-change watcher because Obsidian re-renders
    // the markdown tab header (and resets its icon) after openFile and on
    // various layout events.
    this.startDockedIconWatcher();
    // Compact action bar at the top of the docked editor (Pop out / Send / Close).
    this.attachDockedHeader(leaf);

    const doc = leaf.view.containerEl.ownerDocument;
    // Replace any prior injected font style so we hold the live reference.
    doc.getElementById('pi-prompt-docked-font')?.remove();
    this.dockedFontStyleEl = doc.createElement('style');
    this.dockedFontStyleEl.id = 'pi-prompt-docked-font';
    this.dockedFontStyleEl.textContent = fontRule('.pi-prompt-docked', this.plugin.settings.promptEditorFontSize);
    doc.head.appendChild(this.dockedFontStyleEl);

    this.dockKeydownHandler = (e: KeyboardEvent) => {
      if (this.fileAtSuggester?.isActive) return;
      // Shift+Enter: insert a newline in the prompt editor (don't submit).
      // Obsidian's default sometimes doesn't insert a soft break in this
      // context — handle it explicitly so multiline prompts work.
      if (e.key === 'Enter') {
        // Check if the prompt editor is focused — works for both the popout
        // (workspace.activeEditor) AND the embedded editor (inside TerminalView).
        const activeFile = this.app.workspace.activeEditor?.file;
        const isPopoutEditor = activeFile && activeFile.path === this.promptNotePath;
        const embeddedHost = (this.embeddedLeaf?.view as any)?.contentEl ?? null;
        const isEmbeddedEditor = embeddedHost && embeddedHost.contains(document.activeElement);
        if (isPopoutEditor || isEmbeddedEditor) {
          if (e.shiftKey && !e.metaKey && !e.ctrlKey) {
            // Shift+Enter → insert a newline (multiline prompt)
            e.preventDefault();
            const editor = isPopoutEditor
              ? this.app.workspace.activeEditor?.editor
              : (this.embeddedLeaf?.view as any)?.editor;
            if (editor) {
              const cursor = editor.getCursor();
              editor.replaceRange('\n', cursor);
              editor.setCursor({ line: cursor.line + 1, ch: 0 });
            }
            return;
          }
          if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
            // Plain Enter → submit the prompt (like a chat input)
            e.preventDefault();
            e.stopPropagation();
            new Notice('↵ → sending…', 1000);
            void this.submit();
            return;
          }
        }
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key !== 'Enter') return;
      const activeFile = this.app.workspace.activeEditor?.file;
      if (activeFile && activeFile.path === this.promptNotePath) {
        e.preventDefault();
        e.stopPropagation();
        new Notice('⌘↵ → sending…', 1200);
        void this.submit();
      }
    };
    window.addEventListener('keydown', this.dockKeydownHandler, true);

    this.app.workspace.revealLeaf(leaf);
    this.focusEditorSoon(leaf);
    this.currentSurface = 'docked';
    this.updateSurfaceBtnIcon();
    this.attachFileSuggester();
  }

  /** Adopt an already-open main-window leaf as the embedded prompt editor in the terminal view. */
  private async adoptEmbeddedLeaf(leaf: WorkspaceLeaf): Promise<void> {
    const tv = this.getTerminalView();
    if (!tv) {
      new Notice('Open a pi terminal view before embedding the prompt editor', 3000);
      return;
    }
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      try { leaf.detach(); } catch { /* ignore */ }
      return;
    }
    this.embeddedLeaf = leaf;

    // Hide the tab header and view-header via CSS; the content will be re-parented into the terminal panel.
    const leafAny = leaf as any;
    if (leafAny?.tabHeaderEl) leafAny.tabHeaderEl.style.display = 'none';

    // Inject font-size CSS scoped to the embedded panel (idempotent).
    const doc = view.contentEl.ownerDocument;
    doc.getElementById('pi-prompt-embedded-font')?.remove();
    this.embeddedFontStyleEl = doc.createElement('style');
    this.embeddedFontStyleEl.id = 'pi-prompt-embedded-font';
    this.embeddedFontStyleEl.textContent = fontRule('.pi-prompt-embedded', this.plugin.settings.promptEditorFontSize);
    doc.head.appendChild(this.embeddedFontStyleEl);

    // Build a shared header for the embedded surface and mount it in the terminal.
    this.dockedHeaderEl = this.buildHeader(doc, 'embedded');
    tv.mountEmbeddedPrompt(view, this.dockedHeaderEl);

    // ⌘/Ctrl+Enter while the embedded prompt editor is focused. Same as
    // openEmbedded(): the embedded MarkdownView lives inside TerminalView, so
    // workspace.activeEditor is never this editor — detect focus directly
    // against the embedded leaf's content element instead (was previously
    // checking workspace.activeEditor?.file, which never matched here and
    // silently broke ⌘/Ctrl+Enter whenever the embedded prompt was adopted
    // from an already-open leaf, e.g. on restore/reload).
    if (!this.dockKeydownHandler) {
      this.dockKeydownHandler = (e: KeyboardEvent) => {
        if (this.fileAtSuggester?.isActive) return;
        const mod = e.metaKey || e.ctrlKey;
        if (!mod || e.key !== 'Enter') return;
        const host = (this.embeddedLeaf?.view as any)?.contentEl ?? null;
        if (host && host.contains(document.activeElement)) {
          e.preventDefault();
          e.stopPropagation();
          new Notice('⌘↵ → sending…', 1200);
          void this.submit();
        }
      };
      window.addEventListener('keydown', this.dockKeydownHandler, true);
    }

    this.currentSurface = 'embedded';
    this.updateSurfaceBtnIcon();
    this.focusEditorSoon(leaf);
    this.attachFileSuggester();
  }

  /** Adopt an already-open popout-window leaf as the floating prompt editor. */
  private async adoptPopoutLeaf(leaf: WorkspaceLeaf): Promise<void> {
    this.logLifecycle('adoptPopoutLeaf() start', { leafId: (leaf as any).id, existingLeaf: (this.leaf as any)?.id, existingWin: !!this.win });
    this.leaf = leaf;
    const win = leaf.view.containerEl.ownerDocument.defaultView as Window | null;
    this.win = win;
    this.logLifecycle('adoptPopoutLeaf() win', { win: !!win, closed: win?.closed });
    if (win) {
      const doc = win.document;
      // Inject our popout chrome idempotently — a restored popout window has a
      // fresh DOM, so styles/header from the previous session are gone.
      if (!doc.body.classList.contains('pi-prompt-popout')) {
        doc.body.classList.add('pi-prompt-popout');
        if (typeof process !== 'undefined' && process.platform === 'darwin') {
          doc.body.classList.add('pi-prompt-mac');
        }
      }
      doc.getElementById('pi-prompt-popout-style')?.remove();
      this.styleEl = doc.createElement('style');
      this.styleEl.id = 'pi-prompt-popout-style';
      this.styleEl.textContent = PROMPT_POPOUT_CSS;
      doc.head.appendChild(this.styleEl);

      doc.getElementById('pi-prompt-popout-font')?.remove();
      this.fontStyleEl = doc.createElement('style');
      this.fontStyleEl.id = 'pi-prompt-popout-font';
      this.fontStyleEl.textContent = fontRule('body.pi-prompt-popout', this.plugin.settings.promptEditorFontSize);
      doc.head.appendChild(this.fontStyleEl);

      // Replace any pre-existing header to avoid duplicates.
      doc.querySelector('.pi-prompt-header')?.remove();
      this.headerEl = this.buildHeader(doc, 'popout');
      doc.body.prepend(this.headerEl);
      this.logLifecycle('adoptPopoutLeaf() header injected', { childCount: this.headerEl.childElementCount });

      this.initAlwaysOnTop();

      // ⌘/Ctrl+Enter at the popout window/document/view level (capture).
      // Guarded so repeated adopt attempts on the same restored leaf never
      // double-register.
      if (!this.keydownHandler) {
        this.keydownWin = win;
        this.keydownHandler = (e: KeyboardEvent) => {
          this.logLifecycle('popout keydown', { key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, target: (e.target as HTMLElement)?.tagName });
          if (this.fileAtSuggester?.isActive) return;
          const mod = e.metaKey || e.ctrlKey;
          if (mod && e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            new Notice('⌘↵ → sending…', 1200);
            void this.submit();
          }
        };
        win.addEventListener('keydown', this.keydownHandler, true);
        this.logLifecycle('adoptPopoutLeaf() keydown listener attached to window');
      }

    }

    if (!this.closeRef) {
      this.closeRef = this.app.workspace.on('window-close', (w: WorkspaceWindow) => {
        if (this.win && w.win === this.win) this.cleanupPopout();
      });
    }

    this.focusEditorSoon(leaf);
    // Sweep for orphan OS-level popout windows (zombies from prior sessions)
    // now that we know which BrowserWindow to preserve.
    this.cleanupOrphanPromptWindows();
    this.currentSurface = 'popout';
    this.updateSurfaceBtnIcon();
    this.attachFileSuggester();
  }

  /** Open (or focus) the prompt editor as a floating popout window. */
  async openPopout(): Promise<void> {
    this.logLifecycle('openPopout() start');
    this.closeDocked();
    this.cleanupEmbedded();
    if (this.leaf) { this.win?.focus(); return; }

    const file = await this.ensureScratchNote();
    if (!file) return;
    const settings = this.plugin.settings;

    const leaf = this.app.workspace.openPopoutLeaf({
      size: { width: settings.promptPopoutWidth, height: settings.promptPopoutHeight },
    });
    this.leaf = leaf;
    await leaf.openFile(file, { state: { mode: 'source' } });

    const win = leaf.view.containerEl.ownerDocument.defaultView as Window | null;
    this.win = win;
    if (win) {
      const doc = win.document;
      doc.body.classList.add('pi-prompt-popout');
      // On macOS the native traffic-light buttons sit at top-left; clear them.
      if (typeof process !== 'undefined' && process.platform === 'darwin') {
        doc.body.classList.add('pi-prompt-mac');
      }
      this.styleEl = doc.createElement('style');
      this.styleEl.id = 'pi-prompt-popout-style';
      this.styleEl.textContent = PROMPT_POPOUT_CSS;
      doc.head.appendChild(this.styleEl);

      this.fontStyleEl = doc.createElement('style');
      this.fontStyleEl.id = 'pi-prompt-popout-font';
      this.fontStyleEl.textContent = fontRule('body.pi-prompt-popout', settings.promptEditorFontSize);
      doc.head.appendChild(this.fontStyleEl);

      this.headerEl = this.buildHeader(doc, 'popout');
      doc.body.prepend(this.headerEl);

      // Restore the saved stay-on-top state for this popout window.
      this.initAlwaysOnTop();

      // ⌘/Ctrl+Enter at the popout window level (capture). Guarded so repeated
      // adopt attempts on the same restored leaf never double-register.
      if (!this.keydownHandler) {
        this.keydownWin = win;
        this.keydownHandler = (e: KeyboardEvent) => {
          if (this.fileAtSuggester?.isActive) return;
          const mod = e.metaKey || e.ctrlKey;
          if (mod && e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            new Notice('⌘↵ → sending…', 1200);
            void this.submit();
          }
        };
        win.addEventListener('keydown', this.keydownHandler, true);
      }
    }

    if (!this.closeRef) {
      this.closeRef = this.app.workspace.on('window-close', (w: WorkspaceWindow) => {
        if (this.win && w.win === this.win) this.cleanupPopout();
      });
    }

    this.focusEditorSoon(this.leaf);
    this.currentSurface = 'popout';
    this.updateSurfaceBtnIcon();
    this.attachFileSuggester();
  }

  /** Open (or focus) the prompt editor docked in the main Obsidian window. */
  async openDocked(): Promise<void> {
    this.logLifecycle('openDocked() start');
    this.closePopout();
    this.cleanupEmbedded();
    if (this.dockedLeaf) { this.app.workspace.revealLeaf(this.dockedLeaf); return; }

    const file = await this.ensureScratchNote();
    if (!file) return;
    const settings = this.plugin.settings;

    // New leaf in the main root split (a normal docked pane).
    const leaf = this.app.workspace.getLeaf(true);
    this.dockedLeaf = leaf;
    await leaf.openFile(file, { state: { mode: 'source' } });

    const view = leaf.view;
    if (view instanceof MarkdownView) {
      view.contentEl.addClass('pi-prompt-docked');
    }

    // Swap the tab icon to match the terminal view's prompt-editor button
    // (squircle). Applied via a layout-change watcher because Obsidian re-renders
    // the markdown tab header (and resets its icon) after openFile and on
    // various layout events.
    this.startDockedIconWatcher();
    // Compact action bar at the top of the docked editor (Pop out / Send / Close).
    this.attachDockedHeader(leaf);

    // Font-size CSS for the docked pane (main document).
    const doc = leaf.view.containerEl.ownerDocument;
    this.dockedFontStyleEl = doc.createElement('style');
    this.dockedFontStyleEl.id = 'pi-prompt-docked-font';
    this.dockedFontStyleEl.textContent = fontRule('.pi-prompt-docked', settings.promptEditorFontSize);
    doc.head.appendChild(this.dockedFontStyleEl);

    // ⌘/Ctrl+Enter while the docked prompt note is the active editor.
    // Guarded so repeated adopt attempts on the same restored leaf never
    // double-register listeners.
    if (!this.dockKeydownHandler) {
      this.dockKeydownHandler = (e: KeyboardEvent) => {
        const mod = e.metaKey || e.ctrlKey;
        if (!mod || e.key !== 'Enter') return;
        const activeFile = this.app.workspace.activeEditor?.file;
        if (activeFile && activeFile.path === this.promptNotePath) {
          e.preventDefault();
          e.stopPropagation();
          new Notice('⌘↵ → sending…', 1200);
          void this.submit();
        }
      };
      window.addEventListener('keydown', this.dockKeydownHandler, true);
    }

    this.focusEditorSoon(this.dockedLeaf);
    this.currentSurface = 'docked';
    this.updateSurfaceBtnIcon();
    this.attachFileSuggester();
  }

  /** Open (or focus) the prompt editor embedded as a bottom panel in the pi terminal view. */
  async openEmbedded(): Promise<void> {
    this.logLifecycle('openEmbedded() start');
    this.closePopout();
    this.closeDocked();
    if (this.embeddedLeaf) {
      this.getTerminalView()?.togglePromptPanel();
      return;
    }

    const tv = this.getTerminalView();
    if (!tv) {
      new Notice('Open a pi terminal view before embedding the prompt editor', 3000);
      return;
    }

    const file = await this.ensureScratchNote();
    if (!file) return;
    const settings = this.plugin.settings;

    const leaf = this.app.workspace.getLeaf(true);
    this.embeddedLeaf = leaf;
    await leaf.openFile(file, { state: { mode: 'source' } });

    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      this.embeddedLeaf = null;
      try { leaf.detach(); } catch { /* ignore */ }
      return;
    }

    // Hide the leaf tab header; the view-header is hidden via CSS.
    const leafAny = leaf as any;
    if (leafAny?.tabHeaderEl) leafAny.tabHeaderEl.style.display = 'none';

    // Font-size CSS scoped to the embedded panel.
    const doc = view.contentEl.ownerDocument;
    doc.getElementById('pi-prompt-embedded-font')?.remove();
    this.embeddedFontStyleEl = doc.createElement('style');
    this.embeddedFontStyleEl.id = 'pi-prompt-embedded-font';
    this.embeddedFontStyleEl.textContent = fontRule('.pi-prompt-embedded', settings.promptEditorFontSize);
    doc.head.appendChild(this.embeddedFontStyleEl);

    // Build the shared header and mount the markdown view inside the terminal.
    this.dockedHeaderEl = this.buildHeader(doc, 'embedded');
    tv.mountEmbeddedPrompt(view, this.dockedHeaderEl);

    // ⌘/Ctrl+Enter while the embedded prompt editor is focused. The embedded
    // MarkdownView lives inside the TerminalView, so the workspace's
    // activeEditor is the terminal view, not this editor — instead detect focus
    // directly against the embedded leaf's content element.
    if (!this.dockKeydownHandler) {
      this.dockKeydownHandler = (e: KeyboardEvent) => {
        const mod = e.metaKey || e.ctrlKey;
        if (!mod || e.key !== 'Enter') return;
        const host = (this.embeddedLeaf?.view as any)?.contentEl ?? null;
        if (host && host.contains(document.activeElement)) {
          e.preventDefault();
          e.stopPropagation();
          new Notice('⌘↵ → sending…', 1200);
          void this.submit();
        }
      };
      window.addEventListener('keydown', this.dockKeydownHandler, true);
    }

    this.currentSurface = 'embedded';
    this.updateSurfaceBtnIcon();
    this.focusEditorSoon(leaf);
    this.attachFileSuggester();
  }

  /** Legacy toggle command: focuses the currently-open surface, or opens the default. */
  async toggleSurface(): Promise<void> {
    if (this.leaf) { this.win?.focus(); return; }
    if (this.dockedLeaf) { this.app.workspace.revealLeaf(this.dockedLeaf); return; }
    if (this.embeddedLeaf) { this.getTerminalView()?.togglePromptPanel(); return; }
    await this.open();
  }

  /** Choose the Lucide icon for the surface switcher based on the active surface. */
  private surfaceIcon(surface: 'popout' | 'docked' | 'embedded' | null): string {
    if (surface === 'embedded') return 'panel-top-close';
    if (surface === 'docked') return 'panel-left';
    return 'app-window';
  }

  /** Refresh the surface switcher button icon to match the current surface. */
  private updateSurfaceBtnIcon(): void {
    if (!this.surfaceBtn) return;
    setIcon(this.surfaceBtn, this.surfaceIcon(this.currentSurface));
  }

  /** Briefly pulse the Send button so the user gets visual confirmation that
   * a prompt was dispatched (covers both the toolbar click and ⌘/Ctrl+Enter). */
  private pulseSendBtn(): void {
    const btn = this.sendBtn;
    if (!btn) return;
    btn.classList.remove('is-sending');
    // Reflow to restart the animation if already mid-flight.
    void btn.offsetWidth;
    btn.classList.add('is-sending');
    window.setTimeout(() => btn.classList.remove('is-sending'), 450);
  }

  /** Open a dropdown menu for switching the prompt editor surface. */
  private openSurfaceMenu(e: MouseEvent): void {
    const menu = new Menu();
    const items: Array<{ id: 'popout' | 'docked' | 'embedded'; label: string; icon: string }> = [
      { id: 'popout', label: 'Popout', icon: 'app-window' },
      { id: 'docked', label: 'Docked', icon: 'panel-left' },
      { id: 'embedded', label: 'Embedded', icon: 'panel-top-close' },
    ];
    for (const { id, label, icon } of items) {
      menu.addItem((item) => {
        item.setTitle(label).setIcon(icon).setChecked(this.currentSurface === id).onClick(async () => this.switchSurface(id));
      });
    }
    menu.showAtMouseEvent(e);
  }

  /** Switch the prompt editor to the requested surface and persist the choice. */
  private async switchSurface(target: 'popout' | 'docked' | 'embedded'): Promise<void> {
    if (target === this.currentSurface) {
      if (target === 'popout') this.win?.focus();
      else if (target === 'docked') this.dockedLeaf && this.app.workspace.revealLeaf(this.dockedLeaf);
      else if (target === 'embedded') this.getTerminalView()?.togglePromptPanel();
      return;
    }
    try {
      this.plugin.settings.promptSurface = target;
      await this.plugin.saveSettings();
      await this.close();
      this.updateSurfaceBtnIcon();
      if (target === 'embedded') await this.openEmbedded();
      else if (target === 'docked') await this.openDocked();
      else await this.openPopout();
    } catch (err) {
      console.error('[obsidian-pi] switchSurface failed', err);
      new Notice('Failed to switch prompt surface', 3000);
    }
  }

  // ─── Submit ────────────────────────────────────────────────────────────────

  /** Submit the current scratch-note text to pi via the PTY bridge. */
  async submit(): Promise<void> {
    // Dedupe: the key may be seen by multiple listeners; only act once per ~500ms.
    const now = Date.now();
    if (now - this.lastSubmitAt < 500) return;
    this.lastSubmitAt = now;

    const ptyClient = this.getPtyClient();
    const ahpView = this.getTerminalView();
    if (!ahpView?.isAhp() && (!ptyClient || ptyClient.state !== 'connected')) {
      new Notice('pi terminal is not connected', 3000);
      return;
    }
    const view = (this.leaf?.view ?? this.dockedLeaf?.view ?? this.embeddedLeaf?.view) as MarkdownView | undefined;
    if (!(view instanceof MarkdownView)) {
      new Notice('pi prompt: editor not ready', 2000);
      return;
    }
    const file = view.file;
    if (!file || file.path !== this.promptNotePath) {
      new Notice('pi prompt: active note is not the prompt note', 2500);
      return;
    }

    const raw = view.editor.getValue();
    if (!raw.trim()) {
      new Notice('pi prompt: nothing to send (empty)', 1500);
      return;
    }

    // Bridge: rewrite Obsidian [[wikilinks]] into pi @path mentions.
    const text = this.resolveWikilinks(raw);
    this.pulseSendBtn();
    // Route to the AHP adapter (remote PTY) if AHP mode, else the local PTY.
    if (ahpView?.isAhp()) {
      if (!ahpView.submitPrompt(text)) {
        new Notice('pi terminal is not connected', 3000);
        return;
      }
    } else {
      ptyClient?.submitPrompt(text);
    }
    new Notice('✓ sent to pi', 1200);
    if (this.plugin.settings.clearPromptOnSubmit) {
      view.editor.setValue('');
      view.editor.setCursor(0, 0);
    }
  }

  /** Render the question_user options panel above the editor when the terminal
   *  has a pending question. Called by the option handlers to clear the panel
   *  after an answer is sent. */
  private renderQuestionPanel(): void {
    const view = this.getTerminalView();
    const q = view?.getPendingQuestion?.() ?? null;
    // No pending question — hide the panel.
    if (!q) {
      this.questionPanelEl?.remove();
      this.questionPanelEl = null;
      this.lastQuestionId = null;
      return;
    }
    // Same question already rendered — don't re-render (avoids flicker).
    if (this.questionPanelEl && this.lastQuestionId === q.questionId) return;
    this.lastQuestionId = q.questionId;
    // Find the host (the embedded/docked/popout content area).
    const host = (this.embeddedLeaf?.view as any)?.contentEl
      ?? (this.dockedLeaf?.view as any)?.contentEl
      ?? (this.leaf?.view as any)?.contentEl
      ?? null;
    if (!host) return;
    this.questionPanelEl?.remove();
    const panel = host.createDiv({ cls: 'pi-prompt-question-panel', prepend: true });
    this.questionPanelEl = panel;
    if (q.question) panel.createEl('div', { text: q.question, cls: 'pi-prompt-question-text' });
    const optsEl = panel.createDiv({ cls: 'pi-prompt-question-options' });
    for (const opt of q.options) {
      const btn = optsEl.createEl('button', { text: opt, cls: 'pi-prompt-question-option' });
      btn.addEventListener('click', () => {
        view?.sendQuestionAnswer(q.questionId, opt, false);
        this.renderQuestionPanel(); // clears the panel
        new Notice(`✓ answered: ${opt}`, 1500);
      });
    }
    // Custom answer input (always the last option).
    if (q.allowFreeform) {
      const customWrap = panel.createDiv({ cls: 'pi-prompt-question-custom' });
      const input = customWrap.createEl('input', { type: 'text', placeholder: 'Custom answer…', cls: 'pi-prompt-question-custom-input' });
      const send = customWrap.createEl('button', { text: 'Send', cls: 'pi-prompt-question-custom-send' });
      const submitCustom = () => {
        const val = input.value.trim();
        if (!val) return;
        view?.sendQuestionAnswer(q.questionId, val, true);
        this.renderQuestionPanel();
        new Notice(`✓ answered: ${val}`, 1500);
      };
      send.addEventListener('click', submitCustom);
      input.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); submitCustom(); } });
    }
  }

  /**
   * Convert Obsidian `[[wikilink]]` references into pi `@path` mentions so pi
   * can read the referenced notes. Handles `[[Note]]`, `[[Note#heading]]`,
   * `[[Note|alias]]`, `[[folder/Note]]`, and `![[embed]]`. Unresolved links are
   * left untouched (and reported via a Notice) so the user can fix them.
   */
  private resolveWikilinks(text: string): string {
    const sourcePath = this.promptNotePath;
    const vaultPath = getPluginBasePaths(this.plugin).vaultPath;
    const re = /!?\[\[([^\]\|#]+)(#[^\]\|]*)?(?:\|([^\]]*))?\]\]/g;
    const unresolved: string[] = [];
    const out = text.replace(re, (match, target: string, _heading: string, _alias: string) => {
      const t = target.trim();
      if (!t) return match; // same-note heading link like [[#heading]] — leave as-is
      const dest = this.app.metadataCache.getFirstLinkpathDest(t, sourcePath);
      if (dest instanceof TFile) {
        // Use an absolute filesystem path so pi resolves the @-mention regardless
        // of the instance's cwd (which may differ from the vault root). Image
        // embeds (![[...]]) and note links ([[...]]) are both routed through pi's
        // @path mention, which the model reads via the `read` tool (images are
        // returned as attachments).
        return '@' + vaultPathToAbsolute(vaultPath, dest.path);
      }
      unresolved.push(t);
      return match;
    });
    if (unresolved.length) {
      new Notice(
        'pi prompt: unresolved ' + unresolved.map((x) => '[[' + x + ']]').join(', ') + ' — left as wikilink',
        3500,
      );
    }
    return out;
  }

  // ─── Font size (live) ──────────────────────────────────────────────────────

  /** Live-update the prompt editor font size (called from settings). */
  setEditorFontSize(px: number): void {
    if (this.fontStyleEl) this.fontStyleEl.textContent = fontRule('body.pi-prompt-popout', px);
    if (this.dockedFontStyleEl) this.dockedFontStyleEl.textContent = fontRule('.pi-prompt-docked', px);
    if (this.embeddedFontStyleEl) this.embeddedFontStyleEl.textContent = fontRule('.pi-prompt-embedded', px);
  }

  // ─── Stay on top (Electron BrowserWindow) ──────────────────────────────────

  /** Resolve the popout's Electron BrowserWindow, calling in the popout realm. */
  getPopoutBrowserWindow(): any | null {
    if (!this.win) return null;
    const w = this.win as any;
    // Preferred: cross-window require (no eval, CSP-safe).
    try {
      if (typeof w.require === 'function') {
        let remote: any;
        try { remote = w.require('@electron/remote'); } catch { /* not present */ }
        if (!remote) { try { remote = w.require('electron')?.remote; } catch { /* old electron */ } }
        const bw = remote?.getCurrentWindow?.();
        if (bw) return bw;
      }
    } catch (e) { console.warn('[obsidian-pi:prompt] cross-window require failed', e); }
    // Fallback: read the popout's webContents id via cross-window require
    // (NEVER eval — CSP hazard and a community-plugin-review blocker), then
    // match it against the main realm's BrowserWindow list.
    try {
      if (typeof w.require === 'function' && typeof require === 'function') {
        let popoutRemote: any;
        try { popoutRemote = w.require('@electron/remote'); } catch { try { popoutRemote = w.require('electron')?.remote; } catch { /* none */ } }
        const id = popoutRemote?.getCurrentWebContents?.()?.id;
        if (typeof id === 'number') {
          let remoteMain: any;
          try { remoteMain = require('@electron/remote'); } catch { try { remoteMain = require('electron').remote; } catch { /* none */ } }
          const all = remoteMain?.BrowserWindow?.getAllWindows?.() ?? [];
          const match = all.find((bw: any) => bw.webContents?.id === id);
          if (match) return match;
        }
      }
    } catch (e) { console.warn('[obsidian-pi:prompt] webContents-id fallback failed', e); }
    return null;
  }

  private readAlwaysOnTop(): boolean | null {
    const bw = this.getPopoutBrowserWindow();
    if (!bw) return null;
    try { return !!bw.isAlwaysOnTop(); } catch { return null; }
  }

  /** Apply the always-on-top state; returns the resulting state (or null on failure). */
  private applyAlwaysOnTop(on: boolean): boolean | null {
    const bw = this.getPopoutBrowserWindow();
    if (!bw) return null;
    try { bw.setAlwaysOnTop(on); return !!bw.isAlwaysOnTop(); } catch { return null; }
  }

  /** Toggle always-on-top and persist the choice. */
  async toggleAlwaysOnTop(): Promise<void> {
    if (!this.win) return;
    const current = this.readAlwaysOnTop();
    const next = current == null ? !this.alwaysOnTop : !current;
    const result = this.applyAlwaysOnTop(next);
    if (result == null) {
      new Notice('Could not toggle stay-on-top (Electron remote unavailable)', 3000);
      return;
    }
    this.alwaysOnTop = result;
    this.plugin.settings.promptAlwaysOnTop = result;
    await this.plugin.saveSettings();
    this.refreshAlwaysOnTopBtn();
    new Notice(result ? 'Prompt: staying on top' : 'Prompt: normal window', 1200);
  }

  /** Apply the persisted setting to a freshly opened popout, then sync the button. */
  private initAlwaysOnTop(): void {
    const desired = this.plugin.settings.promptAlwaysOnTop;
    const result = this.applyAlwaysOnTop(desired);
    this.alwaysOnTop = result ?? desired;
    this.refreshAlwaysOnTopBtn();
  }

  private refreshAlwaysOnTopBtn(): void {
    const btn = this.alwaysOnTopBtn;
    if (!btn) return;
    btn.toggleClass('is-active', this.alwaysOnTop);
    btn.title = this.alwaysOnTop ? 'Disable stay on top' : 'Stay on top';
    this.updatePinBtnIcon();
  }

  private updatePinBtnIcon(): void {
    const btn = this.alwaysOnTopBtn;
    if (!btn) return;
    if (this.alwaysOnTop) {
      btn.textContent = '📌';
    } else {
      btn.textContent = '';
      setIcon(btn, 'pin');
    }
  }

  // ─── Close / cleanup ───────────────────────────────────────────────────────

  /** Close whichever surface is open. */
  close(): void {
    this.stopFreshOnLoad();
    this.closePopout();
    if (this.currentSurface === 'embedded' || this.embeddedLeaf) {
      this.cleanupEmbedded();
    } else {
      this.closeDocked();
    }
  }

  private closePopout(): void {
    if (this.leaf) {
      try { this.leaf.detach(); }
      catch (err) { this.logLifecycle('closePopout() leaf.detach() error', (this.leaf as any)?.id, err); }
    }
    this.detachFileSuggester();
    this.stopMic();
    this.cleanupPopout();
  }

  private closeDocked(): void {
    this.stopDockedIconWatcher();
    if (this.dockedLeaf) {
      try { (this.dockedLeaf.view as MarkdownView)?.contentEl?.removeClass('pi-prompt-docked'); } catch (err) { this.logLifecycle('closeDocked() removeClass error', (this.dockedLeaf as any)?.id, err); }
      try { this.dockedLeaf.detach(); } catch (err) { this.logLifecycle('closeDocked() leaf.detach() error', (this.dockedLeaf as any)?.id, err); }
    }
    if (this.dockKeydownHandler) {
      try { window.removeEventListener('keydown', this.dockKeydownHandler, true); } catch { /* gone */ }
    }
    this.dockKeydownHandler = null;
    this.dockedHeaderEl?.remove();
    this.dockedHeaderEl = null;
    this.dockedLayoutStyleEl?.remove();
    this.dockedLayoutStyleEl = null;
    this.dockedFontStyleEl?.remove();
    this.dockedFontStyleEl = null;
    this.dockedLeaf = null;
    this.currentSurface = null;
    this.surfaceBtn = null;
    this.detachFileSuggester();
    this.stopMic();
    this.stopStats();
  }

  /** Clean up the embedded prompt surface and detach its leaf. */
  private cleanupEmbedded(): void {
    const tv = this.getTerminalView();
    if (tv) {
      tv.unmountEmbeddedPrompt();
    }
    if (this.embeddedLeaf) {
      try { this.embeddedLeaf.detach(); } catch (err) { this.logLifecycle('cleanupEmbedded() leaf.detach() error', { embeddedLeaf: !!this.embeddedLeaf }, err); }
    }
    if (this.dockKeydownHandler) {
      try { window.removeEventListener('keydown', this.dockKeydownHandler, true); } catch { /* gone */ }
    }
    this.dockKeydownHandler = null;
    this.dockedHeaderEl?.remove();
    this.dockedHeaderEl = null;
    this.embeddedFontStyleEl?.remove();
    this.embeddedFontStyleEl = null;
    this.embeddedLeaf = null;
    this.currentSurface = null;
    this.surfaceBtn = null;
    this.detachFileSuggester();
    this.stopMic();
    this.stopStats();
  }

  // ─── Docked tab icon (re-applied to survive Obsidian re-renders) ────────────

  /** Resolve the docked leaf's tab-header icon element robustly. */
  private getDockedTabIconEl(): HTMLElement | null {
    const leaf = this.dockedLeaf as (WorkspaceLeaf & { tabHeaderEl?: HTMLElement; tabHeaderInnerIconEl?: HTMLElement }) | null;
    if (!leaf) return null;
    // Prefer the documented-by-community `tabHeaderInnerIconEl`; fall back to a
    // class query on the tab header for older/newer Obsidian builds.
    if (leaf.tabHeaderInnerIconEl) return leaf.tabHeaderInnerIconEl;
    const header = leaf.tabHeaderEl;
    if (header) return header.querySelector('.workspace-tab-header-inner-icon');
    return null;
  }

  /** Set the docked tab icon to the squircle glyph used by the terminal toolbar. */
  private applyDockedTabIcon(): void {
    const iconEl = this.getDockedTabIconEl();
    if (iconEl) setIcon(iconEl, 'squircle');
    // Re-attach the action bar in case Obsidian re-rendered the content element
    // and dropped it (e.g. on source↔reading mode switch).
    if (this.dockedLeaf) this.attachDockedHeader(this.dockedLeaf);
  }

  /**
   * Apply the docked tab icon now (after a frame, so Obsidian's own post-openFile
   * tab render has run) and re-apply it on workspace layout changes, since
   * Obsidian resets markdown tab icons on re-renders.
   */
  private startDockedIconWatcher(): void {
    this.stopDockedIconWatcher();
    const schedule = () => {
      if (this.dockedIconRaf != null) return;
      this.dockedIconRaf = window.requestAnimationFrame(() => {
        this.dockedIconRaf = null;
        this.applyDockedTabIcon();
      });
    };
    schedule();
    this.dockedIconLayoutRef = this.app.workspace.on('layout-change', schedule);
  }

  private stopDockedIconWatcher(): void {
    if (this.dockedIconLayoutRef) {
      try { this.app.workspace.offref(this.dockedIconLayoutRef); } catch { /* gone */ }
      this.dockedIconLayoutRef = null;
    }
    if (this.dockedIconRaf != null) {
      window.cancelAnimationFrame(this.dockedIconRaf);
      this.dockedIconRaf = null;
    }
  }

  private cleanupPopout(): void {
    if (this.closeRef) { this.app.workspace.offref(this.closeRef); this.closeRef = null; }
    if (this.keydownHandler && this.keydownWin) {
      try { this.keydownWin.removeEventListener('keydown', this.keydownHandler, true); } catch { /* gone */ }
    }
    this.keydownHandler = null;
    this.keydownWin = null;
    this.styleEl?.remove();
    this.styleEl = null;
    this.fontStyleEl?.remove();
    this.fontStyleEl = null;
    this.headerEl?.remove();
    this.headerEl = null;
    this.alwaysOnTopBtn = null;
    this.alwaysOnTop = false;
    this.detachFileSuggester();
    this.stopMic();
    this.leaf = null;
    this.win = null;
    this.currentSurface = null;
    this.surfaceBtn = null;
    this.stopStats();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async ensureScratchNote(): Promise<TFile | null> {
    // The prompt note lives under .obsidian/plugins/<id>/prompts/ — outside
    // Obsidian's vault index — so it can't be created/tracked via the normal
    // Vault API. Ensure it on disk via the adapter, then resolve a synthetic
    // TFile (injected into vault.fileMap) that MarkdownView can open. See
    // HiddenNoteRegistry.
    const path = this.promptNotePath;
    try {
      await this.plugin.hiddenNotes.ensureFile(path, '');
    } catch (err) {
      new Notice('Could not create prompt note: ' + (err instanceof Error ? err.message : String(err)), 5000);
      return null;
    }
    return this.plugin.hiddenNotes.getOrCreate(path);
  }

  /** Public entry point: ensure this instance's dedicated prompt note file
   *  exists in the vault (created if missing). Used so each instance has its
   *  own visible 'pi prompt — <name>.md' note in the file explorer, even before
   *  the editor is ever opened. */
  async ensureNote(): Promise<TFile | null> {
    return this.ensureScratchNote();
  }

  /**
   * Build the single merged header row used by ALL surfaces — the floating
   * popout window, the docked pane, and the embedded bottom panel — so they
   * share the same element / markup. The action-toolbar buttons are inlined;
   * The shared surface-switch button (3-mode Popout/Docked/Embedded menu) is
   * appended first on the right for every surface, followed by surface-specific
   * controls:
   *   • every surface → surface-switch · close
   *   • popout additionally has a pin (stay-on-top) button
   */
  private buildHeader(doc: Document, surface: 'popout' | 'docked' | 'embedded'): HTMLElement {
    const header = doc.createElement('div');
    header.className = 'pi-prompt-header';

    // Shared action-toolbar buttons, inlined into this row.
    const actionbar = this.buildActionToolbar(doc);
    header.append(...Array.from(actionbar.children));

    // Surface-switch button (3-mode dropdown: Popout / Docked / Embedded) —
    // replaces the former per-surface popout<->docked toggle buttons. Present
    // on every surface, sitting at the start of the right-side controls.
    this.surfaceBtn = this.makeToolbarBtn(doc, this.surfaceIcon(this.currentSurface), 'Switch prompt surface', (e) => this.openSurfaceMenu(e));
    header.append(this.surfaceBtn);

    if (surface === 'popout') {
      // Stay on top (toggle the popout's Electron BrowserWindow always-on-top).
      const pinBtn = doc.createElement('button');
      pinBtn.className = 'pi-prompt-header-btn';
      pinBtn.title = 'Stay on top';
      pinBtn.setAttribute('aria-label', 'Stay on top');
      pinBtn.textContent = '';
      setIcon(pinBtn, 'pin');
      pinBtn.addEventListener('click', () => {
        this.logLifecycle('header: pin clicked');
        pinBtn.addClass('is-pulsing');
        window.setTimeout(() => pinBtn?.removeClass('is-pulsing'), 350);
        void this.toggleAlwaysOnTop();
      });
      this.alwaysOnTopBtn = pinBtn;
      this.updatePinBtnIcon();

      const closeBtn = doc.createElement('button');
      closeBtn.className = 'pi-prompt-header-btn';
      closeBtn.title = 'Close';
      closeBtn.setAttribute('aria-label', 'Close prompt editor');
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', () => {
        this.logLifecycle('header: close clicked');
        this.closePopout();
      });

      header.append(pinBtn, closeBtn);
    } else if (surface === 'docked') {
      const closeBtn = doc.createElement('button');
      closeBtn.className = 'pi-prompt-header-btn';
      closeBtn.title = 'Close prompt editor';
      closeBtn.setAttribute('aria-label', 'Close prompt editor');
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', () => {
        this.logLifecycle('header: close clicked');
        this.closeDocked();
      });

      header.append(closeBtn);
    } else {
      // Embedded: just a close button.
      const closeBtn = doc.createElement('button');
      closeBtn.className = 'pi-prompt-header-btn';
      closeBtn.title = 'Close prompt editor';
      closeBtn.setAttribute('aria-label', 'Close prompt editor');
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', () => {
        this.logLifecycle('header: close clicked');
        this.close();
      });

      header.append(closeBtn);
    }

    return header;
  }

  // ─── Action toolbar (shared by popout + docked) ────────────────────────────

  /**
   * Build the action-toolbar button row. In the popout its children are inlined
   * into the single merged header row (see buildHeader); in the docked pane its
   * children are inlined the same way via buildHeader('docked').
   *
   * Buttons:
   *   ⤴ Pull from TUI  — grab the in-terminal editor text into this editor
   *   ↵ Send           — submit to pi (⌘/Ctrl+Enter equivalent)
   *   ✕ Clear          — empty the editor
   *   │
   *   📄 Note          — insert the working note's content as a context block
   *   ✂ Selection      — insert the working note's current selection
   *   / Command        — pick a pi slash command, insert at cursor
   *   🔗 Link          — pick a vault note, insert a [[wikilink]] at cursor
 *   🖼 Image         — add an image from the vault / working dir / clipboard
   *   │
   *   # Stats          — toggle a live word/char-count readout
   */
  private buildActionToolbar(doc: Document): HTMLElement {
    const bar = doc.createElement('div');
    bar.className = 'pi-prompt-actionbar';

    const pullBtn = this.makeToolbarBtn(doc, 'hard-drive-download', 'Pull text from TUI editor', () => {
      this.logLifecycle('toolbar: pull clicked');
      void this.pullFromTui();
    });
    this.sendBtn = this.makeToolbarBtn(doc, 'send', 'Send to pi (⌘/Ctrl+Enter)', () => {
      this.logLifecycle('toolbar: send clicked');
      void this.submit();
    });
    const sendBtn = this.sendBtn;
    this.micBtn = this.makeToolbarBtn(doc, 'mic', 'Dictate (click to start/stop)', () => {
      this.logLifecycle('toolbar: mic clicked');
      void this.toggleMic();
    });
    if (!mediaRecorderSupported()) {
      this.micBtn.classList.add('is-disabled');
      this.micBtn.setAttribute('aria-disabled', 'true');
    }
    const clearBtn = this.makeToolbarBtn(doc, 'eraser', 'Clear the editor', () => {
      this.logLifecycle('toolbar: clear clicked');
      this.clearEditor();
    });

    bar.append(pullBtn, sendBtn, this.micBtn, clearBtn, this.makeSep(doc));

    const noteBtn = this.makeToolbarBtn(doc, 'file-text', 'Insert working note as context', () => {
      this.logLifecycle('toolbar: note clicked');
      void this.insertActiveNote();
    });
    const selBtn = this.makeToolbarBtn(doc, 'text-cursor-input', 'Insert selection from working note', () => {
      this.logLifecycle('toolbar: selection clicked');
      void this.insertSelection();
    });
    const cmdBtn = this.makeToolbarBtn(doc, 'square-slash', 'Insert a pi slash command', () => {
      this.logLifecycle('toolbar: command clicked');
      void this.insertCommand();
    });
    const linkBtn = this.makeToolbarBtn(doc, 'link', 'Insert a [[wikilink]] to a vault note', () => {
      this.logLifecycle('toolbar: link clicked');
      void this.insertWikilink();
    });
    const imageBtn = this.makeToolbarBtn(doc, 'image-plus', 'Add an image (vault / working dir / paste)', () => {
      this.logLifecycle('toolbar: image clicked');
      this.openImageMenu(imageBtn);
    });

    bar.append(noteBtn, selBtn, cmdBtn, linkBtn, imageBtn, this.makeSep(doc));

    this.statsBtn = this.makeToolbarBtn(doc, 'bar-chart-3', 'Toggle word/char count', () => this.toggleStats());
    bar.append(this.statsBtn);

    const spacer = doc.createElement('span');
    spacer.className = 'pi-prompt-actionbar-spacer';
    this.statsEl = doc.createElement('span');
    this.statsEl.className = 'pi-prompt-actionbar-stats';
    this.statsEl.style.display = 'none';
    bar.append(spacer, this.statsEl);

    if (this.plugin.settings.promptStatsEnabled) {
      this.enableStats();
    }

    return bar;
  }

  /** Create a single icon-only toolbar button (Lucide icon via setIcon). */
  private makeToolbarBtn(doc: Document, icon: string, label: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'pi-prompt-actionbar-btn';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    setIcon(btn, icon);
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** Create a thin vertical separator. */
  private makeSep(doc: Document): HTMLElement {
    const sep = doc.createElement('span');
    sep.className = 'pi-prompt-actionbar-sep';
    return sep;
  }
  /** The prompt-note MarkdownView for whichever surface is currently open. */
  private getPromptView(): MarkdownView | null {
    const view = (this.leaf?.view ?? this.dockedLeaf?.view ?? this.embeddedLeaf?.view) as MarkdownView | undefined;
    return view instanceof MarkdownView ? view : null;
  }

  // ─── Voice dictation (streaming WebSocket → Whisper sidecar) ─────────────────

  /** Toggle streaming mic dictation on/off. Partial transcripts render live. */
  private async toggleMic(): Promise<void> {
    const btn = this.micBtn;
    if (!btn) return;
    if (!this.plugin.settings.sttServerUrl) {
      new Notice('Set the STT server URL in Settings → Prompt & Voice');
      return;
    }

    if (this.mic?.isRecording()) {
      this.stopMic();
      return;
    }

    const view = this.getPromptView();
    if (!view) {
      new Notice('pi prompt: editor not ready', 2000);
      return;
    }
    this.micAnchor = view.editor.posToOffset(view.editor.getCursor());
    this.micPrevLen = 0;

    try {
      this.removeMicMeter();
      this.mic = new MicStreamer((text, done) => this.onMicUpdate(text, done));
      this.createMicMeter(btn.ownerDocument ?? document);
      await this.mic.start({
        url: this.plugin.settings.sttServerUrl,
        token: this.plugin.effectiveSttToken(),
        lang: this.plugin.settings.sttLanguage,
        model: this.plugin.settings.sttModel,
        onLevel: (levels) => this.drawMeter(levels),
      });
      btn.classList.add('is-recording');
      btn.setAttribute('aria-label', 'Streaming dictation… click to stop');
      setIcon(btn, 'circle');
    } catch (err) {
      new Notice('mic error: ' + (err instanceof Error ? err.message : String(err)));
      this.stopMic();
    }
  }

  /** Live transcript update: overwrite the draft region from micAnchor. */
  private onMicUpdate(text: string, done: boolean): void {
    const view = this.getPromptView();
    if (!view) return;
    const from = view.editor.offsetToPos(this.micAnchor);
    const to = view.editor.offsetToPos(this.micAnchor + this.micPrevLen);
    view.editor.replaceRange(text, from, to);
    this.micPrevLen = text.length;
    view.editor.focus();
    if (done) {
      this.stopMic();
      if (this.plugin.settings.sttAutoSubmit) {
        void this.submit();
      }
    }
  }

  /** Stop streaming mic dictation, reset the toolbar button, and remove the spectrum meter. */
  private stopMic(): void {
    this.mic?.stop();
    this.mic = null;
    this.removeMicMeter();
    const btn = this.micBtn;
    if (btn) {
      setIcon(btn, 'mic');
      btn.classList.remove('is-recording');
      btn.setAttribute('aria-label', 'Dictate (click to start/stop)');
    }
  }

  /** Create and insert the compact spectrum meter canvas next to the mic button. */
  private createMicMeter(doc: Document): void {
    const c = doc.createElement('canvas');
    c.width = 144;
    c.height = 32;
    Object.assign(c.style, {
      width: '72px',
      height: '16px',
      verticalAlign: 'middle',
      marginLeft: '4px',
      display: 'inline-block',
      borderRadius: '3px',
      background: 'var(--background-secondary)',
    });
    this.meterCanvas = c;
    this.micBtn?.parentElement?.appendChild(c);
  }

  /** Draw a compact 16-bar frequency spectrum on the meter canvas. */
  private drawMeter(levels: Uint8Array): void {
    const c = this.meterCanvas;
    if (!c) return;
    // Heal if the toolbar/header was rebuilt while recording (e.g. docked source/reading switch).
    if (!c.isConnected && this.micBtn?.parentElement) {
      try { this.micBtn.parentElement.appendChild(c); } catch { /* ignore cross-document races */ }
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const W = c.width;
    const H = c.height;
    const BARS = 16;
    ctx.clearRect(0, 0, W, H);
    const step = Math.floor(levels.length / BARS);
    const barW = W / BARS;
    for (let i = 0; i < BARS; i++) {
      let v = 0;
      for (let j = 0; j < step; j++) {
        v = Math.max(v, levels[i * step + j]);
      }
      const h = Math.max(1, (v / 255) * H);
      ctx.fillStyle = v > 180 ? '#e53935' : v > 90 ? '#e0a800' : '#3fb950';
      ctx.fillRect(i * barW + 1, H - h, barW - 2, h);
    }
  }

  /** Remove the spectrum meter canvas from the DOM and clear the reference. */
  private removeMicMeter(): void {
    this.meterCanvas?.remove();
    this.meterCanvas = null;
  }

  /** Wire (or re-wire) the @-file-reference suggester to the active prompt view. */
  private attachFileSuggester(): void {
    const view = this.getPromptView();
    if (!view) return;

    this.fileAtSuggester?.destroy();
    this.fileAtSuggester = null;

    const domEl = view.contentEl.querySelector('.cm-editor') as HTMLElement | null ?? view.contentEl;
    const adapter = new CmEditorAdapter(view.editor, domEl);
    this.fileAtSuggester = new FileAtSuggester(adapter, {
      baseDir: this.plugin.getAgentCwd(),
      fdPath: this.plugin.fdPath,
    });
    // Wire image-paste interception on the same CM editor element.
    this.attachPasteImageHandler();
  }

  /** Tear down the @-file-reference suggester. */
  private detachFileSuggester(): void {
    this.fileAtSuggester?.destroy();
    this.fileAtSuggester = null;
    this.detachPasteImageHandler();
  }

  /**
   * Find the "working" note view — the note the user is composing a prompt
   * *about*, i.e. the most recently active MarkdownView that is NOT the prompt
   * note itself. Falls back to the active leaf if it isn't the prompt note.
   */
  private getWorkingNoteView(): MarkdownView | null {
    const promptPath = this.promptNotePath;
    // 1. The plugin-tracked last editor view (excluding the prompt note).
    const last = this.plugin.lastEditorView;
    if (last && last.file && last.file.path !== promptPath) return last;
    // 2. The currently active markdown view (if it isn't the prompt note).
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active && active.file && active.file.path !== promptPath) return active;
    return null;
  }

  /** Insert text at the current cursor position in the prompt editor. */
  private insertAtCursor(text: string, focus = true): void {
    const view = this.getPromptView();
    if (!view) { new Notice('pi prompt: editor not ready', 2000); return; }
    view.editor.replaceSelection(text);
    if (focus) view.editor.focus();
  }

  // ── Button handlers ────────────────────────────────────────────────────────

  /** Pull the current text from pi's in-terminal editor into this editor. */
  private async pullFromTui(): Promise<void> {
    const ptyClient = this.getPtyClient();
    if (!ptyClient || ptyClient.state !== 'connected') {
      new Notice('pi terminal is not connected', 3000);
      return;
    }
    const view = this.getPromptView();
    if (!view) { new Notice('pi prompt: editor not ready', 2000); return; }
    try {
      const text = await ptyClient.requestEditorText();
      if (!text.trim()) {
        new Notice('TUI editor is empty — nothing to pull', 2000);
        return;
      }
      // The user started writing in the TUI and wants to continue here, so the
      // TUI text is the *beginning* of the prompt. Insert at the cursor (which
      // is at the start of an empty editor, or wherever the user placed it).
      this.insertAtCursor(text);
      new Notice(`✓ Pulled ${text.length} chars from TUI`, 1500);
      ptyClient.clearTuiEditor();
    } catch (err) {
      new Notice('Pull failed: ' + (err instanceof Error ? err.message : String(err)), 3500);
    }
  }

  /** Clear the prompt editor. */
  private clearEditor(): void {
    const view = this.getPromptView();
    if (!view) return;
    view.editor.setValue('');
    view.editor.setCursor(0, 0);
    view.editor.focus();
    this.updateStats();
  }

  /** Insert the working note's full content as a delimited context block. */
  private async insertActiveNote(): Promise<void> {
    const vc = this.plugin.vaultContext;
    if (!vc) { new Notice('Vault context unavailable', 2000); return; }
    const working = this.getWorkingNoteView();
    const file = working?.file ?? null;
    if (!file) {
      new Notice('No working note open (open a note in the main window first)', 3000);
      return;
    }
    let content: string;
    try { content = await this.app.vault.read(file); } catch (err) {
      new Notice('Could not read note: ' + (err instanceof Error ? err.message : String(err)), 4000);
      return;
    }
    const resolved = vc.replaceWikilinks(content);
    const block = `\n\nHere is the content of my note "${file.basename}" (at ${vc.getVaultPath()}/${file.path}):\n\n---\n${resolved}\n---\n\n`;
    this.insertAtCursor(block);
    new Notice(`✓ Inserted note: ${file.basename}`, 1500);
  }

  /** Insert the working note's current selection as a delimited context block. */
  private async insertSelection(): Promise<void> {
    const vc = this.plugin.vaultContext;
    if (!vc) { new Notice('Vault context unavailable', 2000); return; }
    const working = this.getWorkingNoteView();
    if (!working) {
      new Notice('No working note open — select text in a note first', 3000);
      return;
    }
    const sel = working.editor.getSelection();
    if (!sel) {
      new Notice('No selection in the working note — select text first', 3000);
      return;
    }
    const filename = working.file?.basename ?? 'unknown';
    const resolved = vc.replaceWikilinks(sel);
    const block = `\n\nHere is the selected text from my note "${filename}":\n\n---\n${resolved}\n---\n\n`;
    this.insertAtCursor(block);
    new Notice(`✓ Inserted selection (${sel.length} chars)`, 1500);
  }

  /** Open the pi command picker and insert the chosen /command at the cursor. */
  private async insertCommand(): Promise<void> {
    const client = this.plugin.rpcClient;
    if (!client || client.state !== 'connected') {
      new Notice('pi RPC is not connected — needed to list commands', 3000);
      return;
    }
    await openCommandPicker(this.app, client, (commandText) => {
      this.insertAtCursor(commandText + ' ');
    });
  }

  /** Open a vault-note picker and insert a [[wikilink]] at the cursor. */
  private async insertWikilink(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    if (files.length === 0) { new Notice('No markdown notes in the vault', 2000); return; }
    const picker = new (class extends FuzzySuggestModal<TFile> {
      constructor(app: App, private readonly onPick: (file: TFile) => void) {
        super(app);
        this.setPlaceholder('Pick a note to link…');
      }
      getItems(): TFile[] { return files; }
      getItemText(item: TFile): string { return item.basename; }
      onChooseItem(item: TFile): void { this.onPick(item); }
    })(this.app, (file) => this.insertAtCursor(`[[${file.basename}]] `));
    picker.open();
  }

  // ─── Image attachment ──────────────────────────────────────────────────────

  /**
   * Dropdown menu for the image button: pick from the vault, from the
   * instance's working directory, or paste the current clipboard image. All
   * three paths insert a pi-readable file reference at the cursor — vault
   * images as a `![[wikilink]]` embed (renders inline in Live Preview and is
   * resolved to an absolute `@path` mention on submit), working-dir / pasted
   * images as an absolute `@path` mention directly.
   */
  private openImageMenu(btn: HTMLButtonElement): void {
    const menu = new Menu();
    menu.addItem((item) => item
      .setTitle('From vault…')
      .setIcon('image')
      .onClick(() => void this.insertImageFromVault()));
    menu.addItem((item) => item
      .setTitle('From working directory…')
      .setIcon('folder-open')
      .onClick(() => void this.insertImageFromCwd()));
    menu.addItem((item) => item
      .setTitle('Paste from clipboard')
      .setIcon('clipboard')
      .onClick(() => void this.pasteImageFromClipboard()));
    const rect = btn.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }

  /** Pick an image file from the vault and insert it as `![[name]]`. */
  private async insertImageFromVault(): Promise<void> {
    const files = this.app.vault.getFiles().filter((f) => isImageFile(f.path));
    if (files.length === 0) { new Notice('No image files found in the vault', 2500); return; }
    const picker = new (class extends FuzzySuggestModal<TFile> {
      constructor(app: App, private readonly onPick: (file: TFile) => void) {
        super(app);
        this.setPlaceholder('Pick an image to attach…');
      }
      getItems(): TFile[] { return files; }
      getItemText(item: TFile): string { return item.path; }
      onChooseItem(item: TFile): void { this.onPick(item); }
    })(this.app, (file) => {
      // Use the full vault path so Obsidian unambiguously resolves the embed
      // (and resolveWikilinks converts it to an absolute @-mention on submit).
      this.insertAtCursor(`![[${file.path}]] `);
      new Notice(`✓ Attached image: ${file.name}`, 1500);
    });
    picker.open();
  }

  /** Pick an image file from the instance cwd and insert it as `@/abs/path`. */
  private async insertImageFromCwd(): Promise<void> {
    const baseDir = this.plugin.getAgentCwd();
    if (!baseDir) { new Notice('No working directory available', 2500); return; }
    const files = await listImageFiles(baseDir, this.plugin.fdPath);
    if (files.length === 0) { new Notice(`No image files found under ${baseDir}`, 3000); return; }
    const picker = new (class extends FuzzySuggestModal<string> {
      constructor(app: App, private readonly onPick: (p: string) => void) {
        super(app);
        this.setPlaceholder('Pick an image to attach…');
      }
      getItems(): string[] { return files; }
      // Show the full path so the user can disambiguate same-named files; the
      // fuzzy matcher uses this string too.
      getItemText(item: string): string { return item; }
      onChooseItem(item: string): void { this.onPick(item); }
    })(this.app, (p) => {
      this.insertAtCursor(`@${p} `);
      new Notice(`✓ Attached image: ${p.replace(/^.*[\\/]/, '')}`, 1500);
    });
    picker.open();
  }

  /** Read the current clipboard image, persist it to a temp file, and insert `@/tmp/...`. */
  private async pasteImageFromClipboard(): Promise<void> {
    const tmp = writeClipboardImageToTemp();
    if (!tmp) { new Notice('No image on the clipboard', 2500); return; }
    this.insertAtCursor(`@${tmp} `);
    new Notice(`✓ Attached image from clipboard (${tmp.split(/[\\/]/).pop()})`, 1500);
  }

  /**
   * Intercept image paste directly in the prompt editor: when the clipboard
   * holds an image, write it to a temp file and insert `@/abs/path` instead of
   * letting Obsidian save a vault attachment (which would land in the hidden
   * prompt-note folder and resolve to a non-absolute path). Text pastes fall
   * through to Obsidian's normal handling.
   */
  private attachPasteImageHandler(): void {
    this.detachPasteImageHandler();
    const view = this.getPromptView();
    if (!view) return;
    const target = (view.contentEl.querySelector('.cm-editor') as HTMLElement | null) ?? view.contentEl;
    const handler = (e: ClipboardEvent) => {
      if (!pasteEventHasImage(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // The system clipboard holds the actual bytes; read via Electron rather
      // than the (sometimes empty) DataTransfer file item.
      const img = readClipboardImage();
      if (!img) { new Notice('Could not read clipboard image', 2500); return; }
      const ext = img.mimeType.split('/')[1] || 'png';
      const tmp = writeImageToTemp(img.bytes, ext);
      this.insertAtCursor(`@${tmp} `);
      new Notice(`✓ Pasted image (${tmp.split(/[\\/]/).pop()})`, 1500);
    };
    target.addEventListener('paste', handler, true);
    this.pasteImageHandler = { target, handler };
  }

  private detachPasteImageHandler(): void {
    if (this.pasteImageHandler) {
      this.pasteImageHandler.target.removeEventListener('paste', this.pasteImageHandler.handler, true);
      this.pasteImageHandler = null;
    }
  }

  /** Toggle the live word/char-count readout on/off. */
  private toggleStats(): void {
    const enabled = !this.statsInterval;
    if (enabled) this.enableStats();
    else this.disableStats();
    this.plugin.settings.promptStatsEnabled = enabled;
    void this.plugin.saveSettings();
  }

  private enableStats(): void {
    if (this.statsInterval) return;
    if (this.statsEl) this.statsEl.style.display = '';
    this.statsBtn?.toggleClass('is-active', true);
    this.updateStats();
    this.statsInterval = setInterval(() => this.updateStats(), 600);
  }

  private disableStats(): void {
    if (!this.statsInterval) return;
    clearInterval(this.statsInterval);
    this.statsInterval = null;
    if (this.statsEl) this.statsEl.style.display = 'none';
    this.statsBtn?.toggleClass('is-active', false);
  }

  /** Update the stats readout from the current editor content. */
  private updateStats(): void {
    if (!this.statsEl || !this.statsInterval) return;
    const view = this.getPromptView();
    const text = view?.editor.getValue() ?? '';
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    this.statsEl.textContent = `${words}w ${text.length}c`;
  }

  /** Stop the stats interval and reset the readout (called on close/surface switch). */
  private stopStats(): void {
    if (this.statsInterval) { clearInterval(this.statsInterval); this.statsInterval = null; }
    if (this.statsEl) this.statsEl.style.display = 'none';
    this.statsBtn?.toggleClass('is-active', false);
  }

  private focusEditorSoon(leaf: WorkspaceLeaf | null): void {
    window.setTimeout(() => {
      const view = leaf?.view;
      if (view instanceof MarkdownView) view.editor?.focus();
    }, 60);
  }

  /**
   * Attach (or re-attach) the single merged header row to the docked pane —
   * the same `.pi-prompt-header` element the floating popout uses, built with
   * `buildHeader(doc, 'docked')`. Prepended to the view content so it sits
   * above the markdown editor. Re-uses an existing element so Obsidian
   * re-renders (source↔reading switch, layout changes) don't lose it.
   */
  private attachDockedHeader(leaf: WorkspaceLeaf): void {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const doc = view.contentEl.ownerDocument;

    // Inject the docked column-layout CSS once per document (idempotent).
    if (!doc.getElementById('pi-prompt-docked-style')) {
      const style = doc.createElement('style');
      style.id = 'pi-prompt-docked-style';
      style.textContent = PROMPT_DOCKED_CSS;
      doc.head.appendChild(style);
      this.dockedLayoutStyleEl = style;
    } else if (!this.dockedLayoutStyleEl) {
      this.dockedLayoutStyleEl = doc.getElementById('pi-prompt-docked-style') as HTMLStyleElement | null;
    }

    // Re-use the existing header element (e.g. re-attaching after a re-render).
    if (this.dockedHeaderEl && this.dockedHeaderEl.isConnected) {
      view.contentEl.insertAdjacentElement('afterbegin', this.dockedHeaderEl);
      return;
    }
    this.dockedHeaderEl = this.buildHeader(doc, 'docked');
    view.contentEl.insertAdjacentElement('afterbegin', this.dockedHeaderEl);
  }
}
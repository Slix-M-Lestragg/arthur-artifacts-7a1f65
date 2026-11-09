/**
 * TerminalView — ItemView hosting the real pi TUI in xterm.js.
 *
 * This is the "pi terminal" surface: a node-pty-backed `pi` interactive process
 * whose ANSI stream feeds xterm.js, giving genuine terminal controls (scrollback,
 * selection, resize, web links, full keyboard) — the experience closest to running
 * pi in a real terminal. The in-terminal prompt editor is replaced by the bundled
 * obsidian-bridge extension's stub, and a floating Obsidian markdown popout
 * (PromptPopout) is the rich composing surface. See ROADMAP/plan for the design.
 */

import { ItemView, MarkdownView, Menu, Notice, Platform, setIcon, setTooltip, WorkspaceLeaf } from 'obsidian';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
// Imported as a text string (esbuild `.css` loader = text) and injected at runtime.
import xtermCss from '@xterm/xterm/css/xterm.css';
import type ObsidianPiPlugin from '../main';
import type { PtyClient, PtyClientState } from '../transport/PtyClient';
import type { AuthBridge, BridgeModel } from '../transport/AuthBridge';
import type { SessionFileInfo } from '../transport/sessionFiles';
import { instanceSessionsDir } from '../instance/InstancePaths';
import { buildInstanceTooltip } from '../instance/InstanceStats';
import { SettingsBridgeModal } from './SettingsBridgeModal';
import { promptForText } from './TextInputModal';
import { getPiTerminalIconName, refreshTerminalLeafIcon, type PiTerminalIconState } from './TerminalIcon';
import { changeInstanceDirectoryInteractive, renameInstanceDirect } from '../instance/instanceActions';
import { AhpTerminalAdapter } from '../transport/AhpTerminalAdapter';
import { isAhpError } from '../transport/AhpError';
import { extractTerminalSnapshot } from '../transport/attachAhpSession';

export const VIEW_TYPE_PI_TERMINAL = 'obsidian-pi-terminal-view';

// Inject xterm.js CSS into the document once (idempotent across views).
let xtermCssInjected = false;
function ensureXtermCss(doc: Document): void {
  if (xtermCssInjected) return;
  const style = doc.createElement('style');
  style.id = 'pi-xterm-css';
  style.textContent = xtermCss;
  doc.head.appendChild(style);
  xtermCssInjected = true;
}

export class TerminalView extends ItemView {
  private readonly plugin: ObsidianPiPlugin;

  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private searchAddon: SearchAddon | null = null;
  private webglAddon: WebglAddon | null = null;
  /** Capture-phase paste handler on the xterm textarea that forwards image
   *  pastes to pi as a Ctrl+V keypress (\x16) so pi's `app.clipboard.pasteImage`
   *  keybinding reads the real OS clipboard. Text pastes fall through to xterm. */
  private termPasteImageHandler: ((e: ClipboardEvent) => void) | null = null;

  private screenEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private currentStatusState: PtyClientState = 'disconnected';

  /** Red "?" badge shown in the top-right corner of the view while the agent
   *  is waiting on user input (question_user) AND this leaf isn't focused. */
  private awaitingInputBadgeEl!: HTMLElement;
  private awaitingInput = false;

  /** Small read-only pill shown in the toolbar when viewing a subagent terminal. */
  private readOnlyBadgeEl!: HTMLElement;

  /** Live tab-icon state (idle/running/done-unseen/seen/awaiting-input/error).
   *  Mirrors InstanceManager's PiInstance.iconState; kept locally so getIcon()
   *  can be synchronous (Obsidian calls it directly when rendering tabs). */
  private visualState: PiTerminalIconState = 'idle';

  /** Inline config panel that drops down under the toolbar row (Session/Model/Settings). */
  private panelEl!: HTMLElement;
  private activePanel: 'session' | 'model' | 'settings' | null = null;
  private sessionBtn!: HTMLButtonElement;
  private modelBtn!: HTMLButtonElement;
  private settingsBtn!: HTMLButtonElement;

  /** Stable id of the pi instance this terminal leaf is bound to. */
  instanceId: string;

  /** True when this terminal hosts a remote AHP session (no PTY) instead of a
   *  local pi instance — the AHP event stream is rendered into xterm via
   *  AhpTerminalAdapter instead of a node-pty subprocess. */
  private ahp = false;
  /** Adapter that renders the AHP event stream into xterm (AHP mode only). */
  private ahpAdapter: AhpTerminalAdapter | null = null;
  /** When set, the AHP adapter boots in interactive terminal (PTY) mode on
   *  this `ahp-terminal:/` channel instead of chat-turn mode. */
  private ahpTerminalUri?: string;
  /** Pending question_user tool call (the question + options) detected on the
   *  session's chat channel — exposed to the PromptPopout so it can render the
   *  options as a selectable list + send the answer via sendQuestionAnswer. */
  private pendingQuestion: { questionId: string; question: string; options: string[]; allowFreeform: boolean } | null = null;
  private ahpChatUnsub: (() => void) | null = null;
  /** When the AHP terminal is externally supervised, the Obsidian viewer must
   *  not fight the real physical PTY for size authority. */
  private ahpTerminalMode?: 'external' | 'server-spawned' | 'none';
  /** Initial cols/rows from the server's subscribe snapshot. Applied to xterm
   *  before any AHP data arrives so the local buffer matches the real PTY. */
  private ahpInitialCols?: number;
  private ahpInitialRows?: number;
  /** Initial scrollback content from the server's subscribe snapshot. Replayed
   *  into xterm before the adapter attaches so the local screen matches the real
   *  terminal and relative cursor redraws render correctly. */
  private ahpInitialContent?: string;
  /** True when the AHP terminal is a read-only mirror (subagent terminal). Keystrokes
   *  are not forwarded and a read-only badge is shown. */
  private ahpReadOnly = false;
  /** PTY-only toolbar controls, hidden in AHP mode. */
  private configGroup!: HTMLElement;
  private promptBtn!: HTMLButtonElement;

  /** True once instanceId has been delivered authoritatively (constructor state,
   *  a re-read in onOpen, or setState) — as opposed to the 'default' fallback
   *  used before Obsidian delivers the real view state. Booting is gated on
   *  this so a non-default instance never attaches to the default's PTY. */
  private instanceIdResolved = false;
  /** True once onOpen has mounted the DOM (xterm needs a live screenEl). */
  private domReady = false;
  /** The instanceId the terminal actually booted for, or null if not yet booted. */
  private bootedInstanceId: string | null = null;
  private bootInProgress = false;

  /** Toolbar label showing instance name + cwd. */
  private instanceLabelEl!: HTMLElement;

  private unsubState: (() => void) | null = null;
  private unsubData: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private fitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last container dimensions we fitted to — prevents re-entrant fit loops
   *  (visualViewport resize → fit → terminal resize → pi redraw → visualViewport
   *  resize → fit → ...) when the size hasn't actually changed. */
  private lastFitWidth = 0;
  private lastFitHeight = 0;
  /** The terminal root container (toolbar + screen + prompt). Stored so the
   *  mobile visualViewport handler can resize it to the visible area above the
   *  keyboard — without this, height:100% + Obsidian's keyboard spacer collide
   *  and the root is squished tiny at the top with a gap below. */
  private rootEl!: HTMLElement;
  private vvHandler: (() => void) | null = null;
  private focusRelayoutHandler: ((e: Event) => void) | null = null;
  private keyboardOpen = false;

  /** Embedded prompt panel hosted inside this terminal view. */
  public promptPanelEl!: HTMLElement;
  public promptResizerEl!: HTMLElement;
  private promptToggleBtn: HTMLButtonElement | null = null;
  private embeddedPromptMounted = false;
  private embeddedPromptLeaf: WorkspaceLeaf | null = null;
  private promptResizeObserver: ResizeObserver | null = null;

  /** Resizer pointer handlers (stored so they can be removed on close). */
  private resizerDownHandler: ((e: PointerEvent) => void) | null = null;
  private resizerMoveHandler: ((e: PointerEvent) => void) | null = null;
  private resizerUpHandler: ((e: PointerEvent) => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianPiPlugin) {
    super(leaf);
    this.plugin = plugin;
    const state = leaf.getViewState()?.state as { instanceId?: string; ahp?: boolean; ahpTerminalUri?: string; ahpTerminalMode?: 'external' | 'server-spawned' | 'none'; ahpInitialCols?: number; ahpInitialRows?: number; ahpInitialContent?: string; ahpReadOnly?: boolean } | undefined;
    const id = state?.instanceId;
    this.ahpTerminalUri = state?.ahpTerminalUri;
    this.ahpTerminalMode = state?.ahpTerminalMode;
    this.ahpInitialCols = state?.ahpInitialCols;
    this.ahpInitialRows = state?.ahpInitialRows;
    this.ahpInitialContent = state?.ahpInitialContent;
    this.ahpReadOnly = !!state?.ahpReadOnly;
    // A restored leaf may run onOpen before the shared AhpClient is ready.
    // Listen for the client-ready event so this leaf can retry boot exactly
    // once after the connection is established.
    this.registerEvent(
      (this.app.workspace as any).on('ahp-client-ready', () => {
        if (!this.disposed && this.bootedInstanceId === null) {
          void this.maybeBoot();
        }
      }),
    );
    // The view-state (instanceId) is delivered by Obsidian via setState(), which
    // may run AFTER onOpen(). At construction time it's often not available yet,
    // so we only mark it "resolved" when we actually receive it, and never boot
    // the PTY on the 'default' fallback (see maybeBoot()) — otherwise a fresh
    // non-default instance would attach to the default instance's already-running
    // PTY before its real id arrives.
    this.ahp = !!state?.ahp;
    this.instanceId = id ?? 'default';
    this.instanceIdResolved = !!id;
  }

  getViewType(): string { return VIEW_TYPE_PI_TERMINAL; }

  getDisplayText(): string {
    if (this.ahp) return this.plugin.ahpSessionTitle || 'AHP remote session';
    const instance = this.plugin.instanceManager.get(this.instanceId);
    const name = instance?.config.name ?? this.instanceId;
    return name;
  }

  getState(): { instanceId: string; ahp?: boolean; ahpTerminalUri?: string; ahpTerminalMode?: 'external' | 'server-spawned' | 'none'; ahpInitialCols?: number; ahpInitialRows?: number; ahpInitialContent?: string; ahpReadOnly?: boolean } {
    if (!this.ahp) return { instanceId: this.instanceId };
    const base: { instanceId: string; ahp: boolean; ahpTerminalUri?: string; ahpTerminalMode?: 'external' | 'server-spawned' | 'none'; ahpInitialCols?: number; ahpInitialRows?: number; ahpInitialContent?: string; ahpReadOnly?: boolean } = {
      instanceId: this.instanceId,
      ahp: true,
    };
    if (this.ahpTerminalUri) base.ahpTerminalUri = this.ahpTerminalUri;
    if (this.ahpTerminalMode) base.ahpTerminalMode = this.ahpTerminalMode;
    if (this.ahpInitialCols !== undefined) base.ahpInitialCols = this.ahpInitialCols;
    if (this.ahpInitialRows !== undefined) base.ahpInitialRows = this.ahpInitialRows;
    if (this.ahpInitialContent !== undefined) base.ahpInitialContent = this.ahpInitialContent;
    if (this.ahpReadOnly) base.ahpReadOnly = true;
    return base;
  }

  /** True when this terminal hosts a remote AHP session (no local PTY). */
  isAhp(): boolean { return this.ahp; }

  async setState(state: { instanceId?: string; ahp?: boolean; ahpTerminalUri?: string; ahpTerminalMode?: 'external' | 'server-spawned' | 'none'; ahpInitialCols?: number; ahpInitialRows?: number; ahpInitialContent?: string; ahpReadOnly?: boolean }, result?: any): Promise<void> {
    await super.setState(state, result);
    const newId = state?.instanceId;
    const newAhp = state?.ahp;
    const newTerminalUri = state?.ahpTerminalUri;
    if (newAhp) this.ahp = true;
    const newTerminalMode = state?.ahpTerminalMode;
    const newInitialCols = state?.ahpInitialCols;
    const newInitialRows = state?.ahpInitialRows;
    const newInitialContent = state?.ahpInitialContent;
    if (newTerminalUri) this.ahpTerminalUri = newTerminalUri;
    if (newTerminalMode) this.ahpTerminalMode = newTerminalMode;
    if (newInitialCols !== undefined) this.ahpInitialCols = newInitialCols;
    if (newInitialRows !== undefined) this.ahpInitialRows = newInitialRows;
    if (newInitialContent !== undefined) this.ahpInitialContent = newInitialContent;
    if (state?.ahpReadOnly !== undefined) this.ahpReadOnly = state.ahpReadOnly;
    this.updateReadOnlyIndicator();
    if (newId) {
      const previousId = this.instanceId;
      // Obsidian can repurpose this SAME TerminalView object for a DIFFERENT
      // instance — e.g. workspace.getRightLeaf(false) may return the sidebar's
      // currently active leaf (already showing another instance's terminal)
      // instead of creating a fresh tab; since the view TYPE is unchanged,
      // Obsidian just calls setState() here rather than reconstructing the
      // view. If we already booted for a different instance, the old PTY
      // subscription/xterm must be torn down and rebooted for the new one —
      // otherwise this view keeps silently displaying/driving the PREVIOUS
      // instance's live session under the new instance's tab label.
      const needsReboot = this.bootedInstanceId !== null && this.bootedInstanceId !== newId;
      this.instanceId = newId;
      this.instanceIdResolved = true;
      this.updateTitle();
      if (needsReboot) {
        await this.rebootForInstance(previousId);
        return;
      }
    }
    // Boot now if onOpen already mounted the DOM but couldn't boot earlier
    // because the instanceId wasn't resolved yet (see maybeBoot()).
    await this.maybeBoot();
  }

  /**
   * Tear down the stale PTY subscription/xterm bound to `previousId` and boot
   * fresh for the current (new) this.instanceId. See setState() for why this
   * is needed — a defensive backstop against Obsidian reusing this view object
   * for a different pi terminal instance.
   */
  private async rebootForInstance(previousId: string): Promise<void> {
    if (this.disposed) return;
    const prevInstance = this.plugin.instanceManager.get(previousId);
    if (prevInstance?.terminalView === this) prevInstance.terminalView = null;
    this.teardownTerminal();
    this.bootedInstanceId = null;
    if (this.disposed) return;
    await this.maybeBoot();
  }

  getIcon(): string {
    return getPiTerminalIconName(this.instanceId, this.plugin.getUiInstances(), this.visualState);
  }

  /** Current tab-icon visual state, read by TerminalIcon.refreshTerminalLeafIcon(). */
  getVisualState(): PiTerminalIconState {
    return this.visualState;
  }

  /** Called by InstanceManager when this instance's lifecycle/notify state changes. */
  setVisualState(state: PiTerminalIconState): void {
    this.visualState = state;
    this.refreshTabIcon();
  }

  /** Recompute this leaf's tab icon (glyph/shape/state classes) + hover tooltip. Public so main.ts's refreshTerminalIcons() (bulk refresh after instance rename/add/remove) can reuse it. */
  refreshTabIcon(): void {
    const instance = this.plugin.instanceManager.get(this.instanceId);
    const tooltip = instance ? buildInstanceTooltip(instance) : undefined;
    refreshTerminalLeafIcon(this.leaf as any, this.app.workspace.activeLeaf === this.leaf, tooltip);
    // Keep the toolbar instance-label tooltip (same stats) in sync too.
    this.updateTitle();
  }

  /** Refresh the tab title and toolbar label from the current instance.
   *  The toolbar label shows only the instance name (the cwd is already shown
   *  inside the pi TUI; duplicating it here made the row too busy). Live
   *  status/model/thinking-level/context/cost are kept as the element's
   *  tooltip (see InstanceStats.buildInstanceTooltip) for quick reference on
   *  hover — deliberately omits the cwd to keep the tooltip compact. */
  updateTitle(): void {
    if (this.ahp) {
      if (this.instanceLabelEl) this.instanceLabelEl.setText(this.plugin.ahpSessionTitle || 'AHP remote session');
      (this.leaf as any).updateDisplayText?.();
      return;
    }
    const instance = this.plugin.instanceManager.get(this.instanceId);
    const name = instance?.config.name ?? this.instanceId;
    if (this.instanceLabelEl) {
      this.instanceLabelEl.setText(name);
      setTooltip(this.instanceLabelEl, instance ? buildInstanceTooltip(instance) : name);
    }
    (this.leaf as any).updateDisplayText?.();
  }

  /** Right-click menu on the in-view instance title: rename / change cwd /
   *  open plugin settings. Change cwd gracefully restarts pi in the new
   *  directory (/quit then respawn). */
  private openInstanceLabelMenu(evt: MouseEvent): void {
    const menu = new Menu();
    if (this.ahp) {
      // AHP terminal: show Disconnect (closes the view + disposes the client)
      menu.addItem((item) =>
        item
          .setTitle('Disconnect remote session')
          .setIcon('unlink')
          .onClick(() => {
            void this.plugin.ahpClient?.dispose();
            this.plugin.ahpClient = null;
            this.plugin.unregisterAhpInstance();
            this.leaf.detach(); // close this view
          }),
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle('Open plugin settings')
          .setIcon('settings')
          .onClick(() => this.openPluginSettings('pi-settings-instances')),
      );
    } else {
      // Local terminal: show Rename / Change directory
      menu.addItem((item) =>
        item
          .setTitle('Rename')
          .setIcon('pencil')
          .onClick(() => { void renameInstanceDirect(this.plugin, this.instanceId); }),
      );
      menu.addItem((item) =>
        item
          .setTitle('Change directory…')
          .setIcon('folder-open')
          .onClick(() => { void changeInstanceDirectoryInteractive(this.plugin, this.instanceId); }),
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle('Open plugin settings')
          .setIcon('settings')
          .onClick(() => this.openPluginSettings('pi-settings-instances')),
      );
    }
    menu.showAtMouseEvent(evt);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  async onOpen(): Promise<void> {
    this.renderShell();
    this.updateTitle();
    // Mobile keyboard handling: resize the terminal root to the visible area
    // above the keyboard so the input stays visible. Three signals catch the
    // keyboard on different devices/browsers:
    //  1. visualViewport resize/scroll (iOS WKWebView — visualViewport.height
    //     shrinks when the keyboard appears)
    //  2. focusin/focusout on the screen element (fallback — xterm's helper
    //     textarea gets focus when the keyboard opens; we re-measure after the
    //     keyboard animation settles)
    //  3. window resize (some Android browsers resize the layout viewport)
    if (Platform.isMobile) {
      // Some mobile webviews (notably iOS WKWebView inside Obsidian) do NOT
      // shrink visualViewport.height or window.innerHeight when the keyboard
      // appears — the keyboard just overlays. So we detect the keyboard via
      // xterm's textarea focus (focusin/focusout) and ESTIMATE the keyboard
      // height (~40% of the viewport on phones) to shrink the terminal above it.
      // If visualViewport DOES report a smaller height, we use the actual value.
      this.keyboardOpen = false;
      this.vvHandler = () => {
        if (this.disposed || !this.rootEl) return;
        const vv = window.visualViewport;
        const winH = window.innerHeight;
        const vvH = vv ? vv.height : winH;
        const vvTop = vv ? vv.offsetTop : 0;
        const rect = this.rootEl.getBoundingClientRect();
        // Did visualViewport report the keyboard (shrunk by >100px)?
        const vvDetected = (winH - vvH) > 100;
        // Effective visible height: actual visualViewport height if it detected
        // the keyboard, else estimate (keyboard ~40% of viewport) when our focus
        // flag says it's open, else full viewport.
        const effectiveH = vvDetected ? vvH : (this.keyboardOpen ? winH * 0.58 : winH);
        const available = effectiveH - (rect.top - vvTop);
        this.rootEl.style.height = `${Math.max(80, available)}px`;
        this.doFit();
        setTimeout(() => this.doFit(), 50);
      };
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', this.vvHandler);
        window.visualViewport.addEventListener('scroll', this.vvHandler);
      }
      window.addEventListener('resize', this.vvHandler);
      // focusin/focusout: xterm's hidden textarea focuses when the keyboard opens.
      // Set the keyboardOpen flag + re-measure after the animation (300ms, 600ms).
      this.focusRelayoutHandler = (e: Event) => {
        if (this.disposed) return;
        if (!this.screenEl.contains(e.target as Node)) return;
        this.keyboardOpen = (e.type === 'focusin');
        setTimeout(() => this.vvHandler?.(), 300);
        setTimeout(() => this.vvHandler?.(), 600);
      };
      this.screenEl.addEventListener('focusin', this.focusRelayoutHandler);
      this.screenEl.addEventListener('focusout', this.focusRelayoutHandler);
      this.vvHandler();
    }
    ensureXtermCss(this.containerEl.ownerDocument);
    this.domReady = true;
    // Re-read the leaf's view state now — by onOpen it's often available even
    // when it wasn't yet at construction time (see constructor + maybeBoot()).
    this.resolveInstanceIdFromLeaf();
    // AHP mode hides the PTY-only toolbar controls + embedded prompt; the flag
    // is not always available at construction (same timing as instanceId), so
    // re-derive it from the view state + bound instance config before booting.
    this.resolveAhpMode();
    if (this.ahp) this.applyAhpMode();
    // Re-evaluate the badge's visibility whenever the active leaf changes —
    // it hides the moment this view becomes focused. Also promotes a pending
    // 'done-unseen' (golden, breathing) tab icon to 'seen' (static green) the
    // moment the user focuses this leaf.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.updateAwaitingInputBadge();
        this.maybeMarkSeen();
        this.refreshTabIcon();
      }),
    );
    // In this Obsidian version onOpen() runs BEFORE setState() applies the
    // initial view-state. Booting here would see stale constructor state and
    // take the local-PTY (node-pty) path for AHP views, crashing with
    // "Failed to load node-pty" before setState() can reboot to AHP mode.
    // Defer the boot decision to the next tick so setState() (which also calls
    // maybeBoot()) has applied ahp:true / ahpTerminalUri first. The double-boot
    // guards in maybeBoot() make the onOpen and setState calls idempotent.
    setTimeout(() => {
      if (!this.disposed) void this.maybeBoot();
    }, 0);
  }

  /** Re-read instanceId from the leaf's current view state, if not already resolved. */
  private resolveInstanceIdFromLeaf(): void {
    if (this.instanceIdResolved) return;
    const state = this.leaf.getViewState()?.state as { instanceId?: string } | undefined;
    if (state?.instanceId) {
      this.instanceId = state.instanceId;
      this.instanceIdResolved = true;
      this.updateTitle();
    }
  }

  /** Re-derive the AHP flag from the view state and the bound instance config.
   *  The flag is not reliably available at construction (same timing as
   *  instanceId), so this is called in onOpen/maybeBoot before any boot
   *  decision. A leaf opened via the ribbon hub / instance command carries the
   *  ahp view-state flag or an ahpTerminalUri channel; one restored from
   *  workspace state is identified by its bound instance (an ahp-flagged entry
   *  in getUiInstances). */
  private resolveAhpMode(): void {
    if (this.ahp) return;
    // The AHP flag can arrive as an explicit view-state boolean, as an
    // ahpTerminalUri channel, or via the bound instance config. We treat any
    // of these as authoritative AHP mode at boot-decision time, so a view whose
    // state arrives late (after onOpen) still goes straight to bootAhpTerminal()
    // and never touches the local PTY path.
    if (this.ahpTerminalUri) { this.ahp = true; return; }
    const st = this.leaf.getViewState()?.state as { ahp?: boolean; ahpTerminalUri?: string } | undefined;
    if (st?.ahp || st?.ahpTerminalUri) { this.ahp = true; return; }
    if (this.instanceIdResolved) {
      const cfg = this.plugin.getUiInstances().find((i) => i.id === this.instanceId);
      if (cfg?.ahp) this.ahp = true;
    }
  }

  /** Hide PTY-only toolbar controls + embedded prompt for AHP mode. The remote
   *  AHP session is rendered into xterm via AhpTerminalAdapter; there is no
   *  local pi instance, prompt popout, or session/model/settings panel. */
  private applyAhpMode(): void {
    // Keep ALL toolbar controls visible (prompt button + config group) — they
    // route to the AHP adapter. The embedded prompt panel + resizer start hidden
    // by CSS (display:none) and are shown by togglePromptPanel/openEmbedded when
    // the user opens the prompt editor — same as local terminals. Don't force-
    // hide them here (that prevented the prompt editor from showing on AHP).
  }

  /**
   * Boot the PTY exactly once, and only once BOTH the DOM is mounted (onOpen)
   * AND the real instanceId has been delivered (constructor, onOpen re-read, or
   * setState) — whichever happens last. This is order-independent: Obsidian may
   * call onOpen before or after setState(), and booting on the 'default'
   * fallback before the real id arrives would silently attach this leaf to the
   * default instance's already-running PTY instead of spawning its own.
   */
  private async maybeBoot(): Promise<void> {
    if (!this.domReady || this.disposed) return;
    if (this.bootedInstanceId !== null || this.bootInProgress) return;
    // AHP mode: render the remote AHP session into xterm. When ahpTerminalUri
    // is set the adapter boots in interactive terminal (PTY) mode; without it
    // (no-node-pty fallback) it boots in chat mode — both go through
    // bootAhpTerminal, never the local PTY path.
    this.resolveAhpMode();
    if (this.ahp) {
      // Hide PTY-only toolbar controls as soon as AHP mode is certain, even if
      // the flag wasn't available when onOpen first ran.
      this.applyAhpMode();
      this.bootInProgress = true;
      try {
        const booted = await this.bootAhpTerminal();
        if (booted) this.bootedInstanceId = 'ahp';
      } finally {
        this.bootInProgress = false;
      }
      if (!this.disposed) this.refreshTabIcon();
      return;
    }
    if (!this.instanceIdResolved) return;
    this.bootInProgress = true;
    try {
      await this.bootTerminal();
      this.bootedInstanceId = this.instanceId;
    } finally {
      this.bootInProgress = false;
    }
    if (this.disposed) return;
    this.awaitingInput = this.plugin.instanceManager.get(this.instanceId)?.awaitingInput ?? false;
    this.updateAwaitingInputBadge();
    this.visualState = this.plugin.instanceManager.get(this.instanceId)?.iconState ?? 'idle';
    this.refreshTabIcon();
  }

  async onClose(): Promise<void> {
    this.disposed = true;
    if (this.vvHandler) {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', this.vvHandler);
        window.visualViewport.removeEventListener('scroll', this.vvHandler);
      }
      window.removeEventListener('resize', this.vvHandler);
      this.vvHandler = null;
    }
    if (this.focusRelayoutHandler) {
      this.screenEl?.removeEventListener('focusin', this.focusRelayoutHandler);
      this.screenEl?.removeEventListener('focusout', this.focusRelayoutHandler);
      this.focusRelayoutHandler = null;
    }
    // Drop the per-instance view reference so restartTerminalSession() and the
    // layout-ready logic don't target a dead view.
    const instance = this.plugin.instanceManager.get(this.instanceId);
    if (instance?.terminalView === this) instance.terminalView = null;
    this.awaitingInputBadgeEl?.removeClass('is-visible');
    this.removeResizerListeners();
    // If the embedded prompt is hosted here, re-parent its MarkdownView content
    // back to its leaf before the leaf is detached, then tear down the leaf.
    if (this.embeddedPromptMounted) {
      this.unmountEmbeddedPrompt();
      this.plugin.instanceManager.getPromptPopout(this.instanceId)?.close();
    }
    this.teardownTerminal();
  }

  /**
   * Rebuild the xterm instance and resubscribe to the (new) PTY client.
   * Used after main.ts's restartTerminalSession() swaps in a fresh PtyClient
   * (e.g. for the "Resume session…" modal, which restarts the subprocess with
   * `--session <path>` rather than driving pi's own `/resume` overlay).
   */
  async restart(): Promise<void> {
    this.teardownTerminal();
    this.disposed = false;
    await this.bootTerminal();
  }

  private teardownTerminal(): void {
    this.closePanel();
    this.ahpChatUnsub?.();
    this.ahpChatUnsub = null;
    this.ahpAdapter?.detach();
    this.ahpAdapter = null;
    this.unsubState?.();
    this.unsubData?.();
    this.unsubState = null;
    this.unsubData = null;
    // Detach the image-paste interceptor from the old xterm textarea before
    // disposing the terminal so a re-boot attaches a fresh handler.
    if (this.termPasteImageHandler && (this.term as any)?.textarea) {
      try {
        ((this.term as any).textarea as HTMLElement).removeEventListener('paste', this.termPasteImageHandler, true);
      } catch { /* terminal already torn down */ }
    }
    this.termPasteImageHandler = null;
    if (this.fitTimer) { clearTimeout(this.fitTimer); this.fitTimer = null; }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.webglAddon?.dispose();
    this.webglAddon = null;
    this.term?.dispose();
    this.term = null;
    this.fitAddon = null;
    this.searchAddon = null;
  }

  // ─── Shell ────────────────────────────────────────────────────────────────

  private renderShell(): void {
    const root = this.contentEl.createDiv({ cls: 'pi-terminal-root' });
    this.rootEl = root;

    // Toolbar: icon-only buttons (Lucide icons via Obsidian's setIcon) in a
    // single row — floating-prompt + pi config buttons (bridged directly to
    // the PTY as native pi slash commands/keybindings — no RPC involved) + status.
    const toolbar = root.createDiv({ cls: 'pi-terminal-toolbar' });

    this.promptBtn = this.createIconButton(toolbar, 'squircle', 'Open prompt editor (⌘E)');
    this.promptBtn.addClass('pi-terminal-prompt-btn');
    this.promptBtn.addEventListener('click', () => {
      const popout = this.plugin.instanceManager.ensurePromptPopout(this.instanceId);
      // Reveal/focus an already-open prompt (any surface); otherwise open the
      // embedded bottom panel by default — the natural per-terminal-view prompt.
      if (popout.isOpen) void popout.open();
      else void popout.openEmbedded();
    });

    this.configGroup = toolbar.createDiv({ cls: 'pi-terminal-config-group' });

    // Session/Model/Settings each toggle an inline panel that drops down under
    // the toolbar (see togglePanel/renderSessionPanel/renderModelPanel/
    // renderSettingsPanel) rather than opening a modal or dropdown menu — all
    // six toolbar buttons stay visible on the row at all times.
    this.sessionBtn = this.createIconButton(this.configGroup, 'layers', 'Session');
    this.sessionBtn.addEventListener('click', () => this.togglePanel('session'));

    this.modelBtn = this.createIconButton(this.configGroup, 'brain-circuit', 'Model');
    this.modelBtn.addEventListener('click', () => this.togglePanel('model'));

    const thinkingBtn = this.createIconButton(
      this.configGroup, 'gauge',
      'Cycle thinking level (Shift+Tab) — pi has no direct-set command, only cycle, so this stays a keybinding.',
    );
    thinkingBtn.addEventListener('click', () => this.sendRaw('\x1b[Z')); // CSI Z = Shift+Tab (CBT)

    const compactBtn = this.createIconButton(this.configGroup, 'weight', 'Compact context, optionally with custom instructions');
    compactBtn.addEventListener('click', () => void this.openCompactModal());

    this.settingsBtn = this.createIconButton(this.configGroup, 'settings-2', 'Settings');
    this.settingsBtn.addEventListener('click', () => this.togglePanel('settings'));

    const pluginSettingsBtn = this.createIconButton(this.configGroup, 'settings', 'Open plugin settings');
    pluginSettingsBtn.addEventListener('click', () => this.openPluginSettings());

    this.instanceLabelEl = toolbar.createEl('span', { cls: 'pi-terminal-instance-label' });
    // Click the title to rename this instance directly (no picker — we know
    // which instance this view is bound to). Right-click opens a small menu
    // with rename / change-directory / open-settings.
    this.instanceLabelEl.addEventListener('click', () => {
      void renameInstanceDirect(this.plugin, this.instanceId);
    });
    this.instanceLabelEl.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      this.openInstanceLabelMenu(evt);
    });

    this.statusEl = toolbar.createDiv({ cls: 'pi-terminal-status' });
    this.statusDot = this.statusEl.createSpan({ cls: 'pi-status-dot' });
    this.statusDot.setAttr('aria-hidden', 'true');
    this.statusText = this.statusEl.createSpan({ cls: 'pi-status-text', text: 'disconnected' });

    this.readOnlyBadgeEl = toolbar.createEl('span', {
      cls: 'pi-terminal-readonly-badge',
      text: 'read-only',
    });
    this.readOnlyBadgeEl.title = 'This subagent terminal is read-only';

    // Inline config panel — hidden until Session/Model/Settings is clicked.
    this.panelEl = root.createDiv({ cls: 'pi-terminal-panel' });
    this.panelEl.style.display = 'none';

    // xterm host — fills remaining space.
    this.screenEl = root.createDiv({ cls: 'pi-terminal-screen' });

    // Resizable bottom panel for the embedded prompt editor.
    this.promptResizerEl = root.createDiv({ cls: 'pi-terminal-prompt-resizer' });
    this.promptPanelEl = root.createDiv({ cls: 'pi-terminal-prompt-panel' });
    this.setupResizerDrag();

    // Status bar is announced to screen readers when connection state changes.
    this.statusEl.setAttr('role', 'status');
    this.statusEl.setAttr('aria-live', 'polite');

    // Unfocused "awaiting input" badge — top-right corner of the view.
    this.awaitingInputBadgeEl = root.createDiv({ cls: 'pi-terminal-awaiting-badge' });
    this.awaitingInputBadgeEl.setText('?');
    this.awaitingInputBadgeEl.setAttr('aria-hidden', 'true');
    this.awaitingInputBadgeEl.title = 'Agent is waiting for your input';
    this.awaitingInputBadgeEl.addEventListener('click', () => this.term?.focus());
  }

  /** Called by InstanceManager when this instance's agent starts/stops waiting on user input. */
  setAwaitingInput(pending: boolean): void {
    this.awaitingInput = pending;
    this.updateAwaitingInputBadge();
  }

  /** Badge is visible only while awaiting input AND this leaf isn't the active one. */
  private updateAwaitingInputBadge(): void {
    if (!this.awaitingInputBadgeEl) return;
    const isFocused = this.app.workspace.activeLeaf === this.leaf;
    this.awaitingInputBadgeEl.toggleClass('is-visible', this.awaitingInput && !isFocused);
  }

  /** Show the read-only badge for subagent terminals, hide it otherwise. */
  private updateReadOnlyIndicator(): void {
    if (!this.readOnlyBadgeEl) return;
    this.readOnlyBadgeEl.toggleClass('is-visible', this.ahp && this.ahpReadOnly);
  }

  /** Promote a golden 'done-unseen' tab icon to static green 'seen' once this leaf is focused. */
  private maybeMarkSeen(): void {
    if (this.visualState !== 'done-unseen') return;
    if (this.app.workspace.activeLeaf !== this.leaf) return;
    const instance = this.plugin.instanceManager.get(this.instanceId);
    if (instance) instance.iconState = 'seen';
    this.setVisualState('seen');
  }

  /**
   * Icon-only toolbar button (Lucide icon via Obsidian's setIcon, no visible
   * label) — keeps the toolbar to a single row. `label` is kept as a native
   * hover tooltip + aria-label for discoverability/accessibility even though
   * there's no visible text.
   */
  private createIconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const btn = parent.createEl('button', { cls: 'pi-terminal-btn' });
    setIcon(btn, icon);
    btn.title = label;
    btn.setAttr('aria-label', label);
    return btn;
  }

  // ─── Embedded prompt panel ───────────────────────────────────────────────

  /** Show/hide the embedded prompt bottom panel. */
  togglePromptPanel(): void {
    if (!this.embeddedPromptMounted) {
      void this.plugin.instanceManager.ensurePromptPopout(this.instanceId).open();
      return;
    }
    const visible = !this.promptPanelEl.hasClass('is-visible');
    this.promptPanelEl.toggleClass('is-visible', visible);
    this.promptResizerEl.toggleClass('is-visible', visible);
    this.promptToggleBtn?.toggleClass('is-active', visible);
    this.scheduleFit();
  }

  /** Mount a MarkdownView into the bottom panel as the embedded prompt editor. */
  public mountEmbeddedPrompt(view: MarkdownView, headerEl: HTMLElement): void {
    this.embeddedPromptLeaf = view.leaf;
    this.embeddedPromptMounted = true;

    this.promptPanelEl.empty();
    this.promptPanelEl.addClass('pi-prompt-embedded');
    this.promptPanelEl.append(headerEl);
    this.promptPanelEl.append(view.contentEl);

    view.containerEl?.addClass('pi-prompt-embedded');
    const leafAny = view.leaf as any;
    if (leafAny?.tabHeaderEl) leafAny.tabHeaderEl.style.display = 'none';

    this.promptPanelEl.addClass('is-visible');
    this.promptResizerEl.addClass('is-visible');
    this.promptToggleBtn?.addClass('is-active');

    this.promptResizeObserver?.disconnect();
    this.promptResizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.promptResizeObserver.observe(this.promptPanelEl);

    this.scheduleFit();
  }

  /** Detach the embedded MarkdownView from the panel and return it to its leaf for clean destruction. */
  public unmountEmbeddedPrompt(): void {
    if (!this.embeddedPromptMounted) return;

    const view = this.embeddedPromptLeaf?.view as MarkdownView | undefined;
    if (view?.contentEl && view.containerEl && !view.containerEl.contains(view.contentEl) && view.containerEl.isConnected) {
      view.containerEl.append(view.contentEl);
    }
    view?.containerEl?.removeClass('pi-prompt-embedded');
    const leafAny = view?.leaf as any;
    if (leafAny?.tabHeaderEl) leafAny.tabHeaderEl.style.display = '';

    this.promptPanelEl.empty();
    this.promptPanelEl.removeClass('pi-prompt-embedded', 'is-visible');
    this.promptResizerEl.removeClass('is-visible');
    this.promptToggleBtn?.removeClass('is-active');

    this.promptResizeObserver?.disconnect();
    this.promptResizeObserver = null;
    this.embeddedPromptMounted = false;
    this.embeddedPromptLeaf = null;

    this.scheduleFit();
  }

  private setupResizerDrag(): void {
    let active = false;
    let startY = 0;
    let startH = 0;

    this.resizerDownHandler = (e: PointerEvent) => {
      active = true;
      startY = e.clientY;
      startH = this.promptPanelEl.offsetHeight || 200;
      this.promptResizerEl.setPointerCapture?.(e.pointerId);
    };
    this.resizerMoveHandler = (e: PointerEvent) => {
      if (!active) return;
      const dy = e.clientY - startY;
      const root = this.contentEl.querySelector('.pi-terminal-root') as HTMLElement | null;
      const maxH = root ? Math.round(root.clientHeight * 0.6) : 9999;
      const h = Math.max(80, Math.min(maxH, startH - dy));
      this.promptPanelEl.style.height = `${h}px`;
      this.scheduleFit();
    };
    this.resizerUpHandler = (e: PointerEvent) => {
      active = false;
      try { this.promptResizerEl.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    };

    this.promptResizerEl.addEventListener('pointerdown', this.resizerDownHandler);
    this.promptResizerEl.addEventListener('pointermove', this.resizerMoveHandler);
    this.promptResizerEl.addEventListener('pointerup', this.resizerUpHandler);
    this.promptResizerEl.addEventListener('pointercancel', this.resizerUpHandler);
  }

  private removeResizerListeners(): void {
    if (this.resizerDownHandler) this.promptResizerEl?.removeEventListener('pointerdown', this.resizerDownHandler);
    if (this.resizerMoveHandler) this.promptResizerEl?.removeEventListener('pointermove', this.resizerMoveHandler);
    if (this.resizerUpHandler) {
      this.promptResizerEl?.removeEventListener('pointerup', this.resizerUpHandler);
      this.promptResizerEl?.removeEventListener('pointercancel', this.resizerUpHandler);
    }
    this.resizerDownHandler = null;
    this.resizerMoveHandler = null;
    this.resizerUpHandler = null;
  }

  // ─── Inline config panel (drops down under the toolbar — Session/Model/Settings) ───

  /** Toggle one of the three inline config panels; toggling the active one again closes it. */
  private togglePanel(kind: 'session' | 'model' | 'settings'): void {
    if (this.activePanel === kind) {
      this.closePanel();
      return;
    }
    this.closePanel();
    this.activePanel = kind;
    this.updateActiveButtons();
    this.panelEl.empty();
    this.panelEl.style.display = '';
    if (kind === 'session') void this.renderSessionPanel();
    else if (kind === 'model') void this.renderModelPanel();
    else void this.renderSettingsPanel();
  }

  /** Close whichever panel is open, releasing the auth bridge if the panel held a reference to it. */
  private closePanel(): void {
    if (this.activePanel === 'model' || this.activePanel === 'settings') {
      this.plugin.releaseAuthBridge();
    }
    this.activePanel = null;
    this.updateActiveButtons();
    if (this.panelEl) {
      this.panelEl.style.display = 'none';
      this.panelEl.empty();
    }
  }

  private updateActiveButtons(): void {
    this.sessionBtn?.toggleClass('is-active', this.activePanel === 'session');
    this.modelBtn?.toggleClass('is-active', this.activePanel === 'model');
    this.settingsBtn?.toggleClass('is-active', this.activePanel === 'settings');
  }

  /** Session panel — quick actions + inline resume list scoped to this terminal's instance. */
  private async renderSessionPanel(): Promise<void> {
    const panel = this.panelEl;

    const quickRow = panel.createDiv({ cls: 'pi-panel-row' });
    const newBtn = quickRow.createEl('button', { cls: 'pi-panel-btn', text: 'New' });
    newBtn.addEventListener('click', () => this.sendSlashCommand('/new'));
    const cloneBtn = quickRow.createEl('button', { cls: 'pi-panel-btn', text: 'Clone' });
    cloneBtn.addEventListener('click', () => this.sendSlashCommand('/clone'));
    const infoBtn = quickRow.createEl('button', { cls: 'pi-panel-btn', text: 'Info' });
    infoBtn.addEventListener('click', () => this.sendSlashCommand('/session'));
    const forkBtn = quickRow.createEl('button', { cls: 'pi-panel-btn', text: 'Fork…' });
    forkBtn.title = 'pi has no non-interactive form for /fork — opens its own message picker in the terminal.';
    forkBtn.addEventListener('click', () => {
      new Notice('Fork requires picking a message — opening pi\'s own selector in the terminal…', 3000);
      this.sendSlashCommand('/fork');
    });

    const nameRow = panel.createDiv({ cls: 'pi-panel-row' });
    const nameInput = nameRow.createEl('input', { type: 'text', cls: 'pi-panel-input' });
    nameInput.placeholder = 'Session name…';
    const nameBtn = nameRow.createEl('button', { cls: 'pi-panel-btn', text: 'Set name' });
    const submitName = () => {
      const name = nameInput.value.trim();
      if (name) this.sendSlashCommand(`/name ${name}`);
    };
    nameBtn.addEventListener('click', submitName);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitName(); });

    panel.createEl('div', { cls: 'pi-panel-subtitle', text: 'Resume' });
    const list = panel.createDiv({ cls: 'pi-panel-list' });
    const instance = this.plugin.instanceManager.getOrCreate(this.instanceId);
    let sessions: SessionFileInfo[] = [];
    if (Platform.isDesktop) {
      const { listSessionFilesInDir } = await import('../transport/sessionFiles');
      const sessionsDir = instanceSessionsDir(this.plugin, instance.config);
      sessions = listSessionFilesInDir(sessionsDir);
    }
    if (sessions.length === 0) {
      list.createDiv({ cls: 'pi-panel-empty', text: 'No saved sessions' });
      return;
    }
    for (const s of sessions) {
      const row = list.createDiv({ cls: 'pi-panel-list-item' });
      const date = new Date(s.mtime).toLocaleDateString();
      const time = new Date(s.mtime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      row.createSpan({ cls: 'pi-panel-list-item-label', text: s.displayName });
      row.createSpan({ cls: 'pi-panel-list-item-meta', text: `${date} ${time}` });
      row.addEventListener('click', () => {
        new Notice('Resuming session…', 2000);
        void this.plugin.instanceManager.restartTerminalSession(this.instanceId, s.path);
        this.closePanel();
      });
    }
  }

  /**
   * Model panel — filterable inline list fed by the SDK bridge's ModelRegistry
   * (no RPC channel from the terminal). Clicking a row applies it immediately
   * via `/model provider/id`, which pi's own command parser sets directly with
   * no picker overlay (findExactModelReferenceMatch).
   */
  private async renderModelPanel(): Promise<void> {
    const panel = this.panelEl;
    const filterInput = panel.createEl('input', { type: 'text', cls: 'pi-panel-input' });
    filterInput.placeholder = 'Filter models…';
    const list = panel.createDiv({ cls: 'pi-panel-list' });
    list.createDiv({ cls: 'pi-panel-empty', text: 'Loading…' });

    const bridge = await this.plugin.ensureAuthBridge();
    if (this.activePanel !== 'model') { if (bridge) this.plugin.releaseAuthBridge(); return; } // panel switched away while loading
    if (!bridge) {
      list.empty();
      list.createDiv({ cls: 'pi-panel-empty', text: 'Auth bridge unavailable — see the Notice above.' });
      return;
    }

    let models: BridgeModel[] = [];
    try {
      models = await bridge.getAvailableModels();
    } catch (err) {
      list.empty();
      list.createDiv({ cls: 'pi-panel-empty', text: `Failed to load models: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    if (this.activePanel !== 'model') return; // switched away while loading

    if (models.length === 0) {
      list.empty();
      list.createDiv({ cls: 'pi-panel-empty', text: 'No models available — configure a provider first' });
      return;
    }

    const renderList = (filter: string) => {
      list.empty();
      const f = filter.trim().toLowerCase();
      const filtered = f
        ? models.filter((m) => m.name.toLowerCase().includes(f) || m.id.toLowerCase().includes(f) || m.provider.toLowerCase().includes(f))
        : models;
      if (filtered.length === 0) {
        list.createDiv({ cls: 'pi-panel-empty', text: 'No matches' });
        return;
      }
      for (const m of filtered) {
        const row = list.createDiv({ cls: 'pi-panel-list-item' });
        row.createSpan({ cls: 'pi-panel-list-item-label', text: m.name });
        row.createSpan({ cls: 'pi-panel-list-item-meta', text: `${m.provider}/${m.id}` });
        row.addEventListener('click', () => {
          this.sendSlashCommand(`/model ${m.provider}/${m.id}`);
          new Notice(`Model: ${m.name}`, 2000);
        });
      }
    };
    renderList('');
    filterInput.addEventListener('input', () => renderList(filterInput.value));
  }

  /**
   * Settings panel — a compact subset of SettingsBridgeModal's fields (default
   * model, thinking level, auto-compaction) for quick inline edits, with a
   * "More…" escape hatch to the full modal for trust/warnings/provider.
   */
  private async renderSettingsPanel(): Promise<void> {
    const panel = this.panelEl;
    panel.createDiv({ cls: 'pi-panel-empty', text: 'Loading…' });

    const bridge = await this.plugin.ensureAuthBridge();
    if (this.activePanel !== 'settings') { if (bridge) this.plugin.releaseAuthBridge(); return; }
    panel.empty();
    if (!bridge) {
      panel.createDiv({ cls: 'pi-panel-empty', text: 'Auth bridge unavailable — see the Notice above.' });
      return;
    }

    let snapshot;
    try {
      snapshot = await bridge.getSettings();
    } catch (err) {
      panel.createDiv({ cls: 'pi-panel-empty', text: `Failed to load settings: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    if (this.activePanel !== 'settings') return; // switched away while loading

    this.buildCompactSettingsForm(panel, bridge, snapshot.global);
  }

  private buildCompactSettingsForm(panel: HTMLElement, bridge: AuthBridge, g: Record<string, unknown>): void {
    const overrides: Record<string, unknown> = {};

    const modelRow = panel.createDiv({ cls: 'pi-panel-row' });
    modelRow.createSpan({ cls: 'pi-panel-label', text: 'Model' });
    const modelInput = modelRow.createEl('input', { type: 'text', cls: 'pi-panel-input' });
    modelInput.placeholder = 'claude-sonnet-4-5';
    modelInput.value = (g['defaultModel'] as string) ?? '';
    modelInput.addEventListener('input', () => { overrides.defaultModel = modelInput.value.trim() || undefined; });

    const thinkingRow = panel.createDiv({ cls: 'pi-panel-row' });
    thinkingRow.createSpan({ cls: 'pi-panel-label', text: 'Thinking' });
    const thinkingSelect = thinkingRow.createEl('select', { cls: 'pi-panel-select' });
    const currentThinking = (g['defaultThinkingLevel'] as string) ?? '';
    thinkingSelect.createEl('option', { text: '(unset)', value: '' });
    for (const lvl of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      const opt = thinkingSelect.createEl('option', { text: lvl, value: lvl });
      if (currentThinking === lvl) opt.selected = true;
    }
    thinkingSelect.addEventListener('change', () => { overrides.defaultThinkingLevel = thinkingSelect.value || undefined; });

    const compactionRow = panel.createDiv({ cls: 'pi-panel-row' });
    compactionRow.createSpan({ cls: 'pi-panel-label', text: 'Auto-compact' });
    const compactionToggle = compactionRow.createEl('input', { type: 'checkbox' });
    const compaction = (g['compaction'] as { enabled?: boolean } | undefined) ?? {};
    compactionToggle.checked = compaction.enabled ?? true;
    compactionToggle.addEventListener('change', () => { overrides.compaction = { enabled: compactionToggle.checked }; });

    const actionsRow = panel.createDiv({ cls: 'pi-panel-row' });
    const saveBtn = actionsRow.createEl('button', { cls: 'pi-panel-btn mod-cta', text: 'Save' });
    saveBtn.addEventListener('click', () => void this.saveCompactSettings(bridge, overrides));
    const moreBtn = actionsRow.createEl('button', { cls: 'pi-panel-btn', text: 'More…' });
    moreBtn.title = 'Open the full settings dialog (provider, trust, warnings)';
    moreBtn.addEventListener('click', () => {
      this.closePanel();
      new SettingsBridgeModal(this.app, this.plugin).open();
    });
  }

  private async saveCompactSettings(bridge: AuthBridge, overrides: Record<string, unknown>): Promise<void> {
    const cleaned = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
    if (Object.keys(cleaned).length === 0) {
      new Notice('No changes to save', 2000);
      return;
    }
    try {
      await bridge.applySettingsOverrides(cleaned);
      await bridge.flushSettings();
      const errors = await bridge.drainErrors();
      if (errors.settings.length > 0) {
        new Notice(`Settings saved with errors: ${errors.settings.map((e) => e.message).join('; ')}`, 8000);
      } else {
        new Notice('Settings saved', 2000);
      }
    } catch (err) {
      new Notice(`Failed to save settings: ${err instanceof Error ? err.message : String(err)}`, 6000);
    }
  }

  private async openCompactModal(): Promise<void> {
    const instructions = await promptForText('Compact context (optional custom instructions, leave blank for default)', this.app);
    // promptForText returns null on cancel/empty — both should still allow a
    // plain "/compact" with no instructions rather than doing nothing, since
    // an empty prompt is a valid choice here (unlike Set name, where empty
    // means "cancelled"). We can't distinguish "cancelled" from "submitted
    // empty" through promptForText's null-on-empty contract, so treat both as
    // "run /compact with no custom instructions".
    this.sendSlashCommand(instructions ? `/compact ${instructions}` : '/compact');
  }

  /**
   * Write a pi slash command directly into the PTY, followed by Enter. All
   * commands used here (/model <ref>, /new, /clone, /name <name>, /compact
   * [text], /session) apply immediately with no TUI overlay — confirmed
   * against pi's own command parsing in interactive-mode.js. Only /fork falls
   * back to pi's native selector (see openSessionModal).
   */
  private getInstancePtyClient(): PtyClient | null {
    return this.plugin.instanceManager.get(this.instanceId)?.ptyClient ?? null;
  }

  private sendSlashCommand(command: string): void {
    // AHP remote terminal: route to the AHP adapter (sends to the remote PTY).
    if (this.ahp && this.ahpAdapter) {
      this.ahpAdapter.sendRaw(command + '\r');
      this.term?.focus();
      return;
    }
    const client = this.getInstancePtyClient();
    if (!client || client.state !== 'connected') {
      new Notice('pi terminal is not connected', 3000);
      return;
    }
    client.write(command + '\r');
    this.term?.focus();
  }

  /** Open Obsidian's Settings dialog, jumped straight to this plugin's tab. */
  private openPluginSettings(anchorId?: string): void {
    const settingApi = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    settingApi?.open();
    settingApi?.openTabById('obsidian-pi');
    if (anchorId) {
      // Obsidian renders the settings tab content asynchronously after openTabById,
      // so a fixed setTimeout fires before the section exists. Poll on rAF until
      // the anchor appears (or ~2s elapse), then scroll it into view.
      const start = Date.now();
      const tryScroll = (): void => {
        const el = document.getElementById(anchorId);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        if (Date.now() - start < 2000) requestAnimationFrame(tryScroll);
      };
      requestAnimationFrame(tryScroll);
    }
  }

  /** Write a raw control/escape sequence directly into the PTY (e.g. Shift+Tab). */
  private sendRaw(sequence: string): void {
    if (this.ahp && this.ahpAdapter) {
      this.ahpAdapter.sendRaw(sequence);
      this.term?.focus();
      return;
    }
    const client = this.getInstancePtyClient();
    if (!client || client.state !== 'connected') return;
    client.write(sequence);
    this.term?.focus();
  }

  /** Submit a prompt to the active terminal — routes to the AHP adapter (remote
   *  PTY) if in AHP mode, else the local PtyClient. Used by the PromptPopout so
   *  the prompt editor works identically on local + remote terminals. */
  submitPrompt(text: string): boolean {
    if (this.ahp && this.ahpAdapter) {
      this.ahpAdapter.submitPrompt(text);
      return true;
    }
    const client = this.getInstancePtyClient();
    if (!client || client.state !== 'connected') return false;
    client.submitPrompt(text);
    return true;
  }

  /** The active question_user tool call (question + options), or null. The
   *  PromptPopout reads this to render the options as a selectable list. */
  getPendingQuestion(): { questionId: string; question: string; options: string[]; allowFreeform: boolean } | null {
    return this.pendingQuestion;
  }

  /** Answer an in-flight question_user tool call on the remote PTY (APC marker). */
  sendQuestionAnswer(questionId: string, answer: string, wasCustom: boolean): boolean {
    if (this.ahp && this.ahpAdapter) {
      this.ahpAdapter.sendQuestionAnswer(questionId, answer, wasCustom);
      this.pendingQuestion = null;
      return true;
    }
    return false;
  }

  /** Subscribe to the session's chat channel to detect in-flight question_user
   *  tool calls (the question + options in the toolInput). Updates
   *  pendingQuestion live so the PromptPopout can render the options. */
  private subscribeToChatForQuestions(client: import('../transport/AhpClient').AhpClient): void {
    if (!this.ahpTerminalUri || this.ahpChatUnsub) return;
    const chatUri = this.ahpTerminalUri.replace(/^ahp-terminal:/, 'ahp-chat:');
    const detect = (chat: { activeTurn?: { responseParts?: unknown[] } } | null | undefined) => {
      const turn = chat?.activeTurn;
      if (!turn?.responseParts) { this.pendingQuestion = null; return; }
      for (const part of turn.responseParts) {
        const tc = (part as { kind?: string; toolCall?: Record<string, unknown> }).toolCall;
        if ((part as { kind?: string }).kind === 'toolCall' && tc?.toolName === 'question_user' && tc.status === 'streaming') {
          const input = tc.toolInput as { question?: string; options?: unknown[]; allowFreeform?: boolean } | undefined;
          const opts = (input?.options ?? []).map((o) => typeof o === 'string' ? o : (o as { label?: string })?.label ?? String(o));
          this.pendingQuestion = {
            questionId: tc.toolCallId as string,
            question: input?.question ?? '',
            options: opts,
            allowFreeform: input?.allowFreeform ?? true,
          };
          return;
        }
      }
      this.pendingQuestion = null;
    };
    // Subscribe to the chat channel — the snapshot carries the current state.
    void client.subscribe(chatUri).then((snap) => {
      const chat = (snap as { snapshot?: { state?: unknown } })?.snapshot?.state as { activeTurn?: { responseParts?: unknown[] } } | undefined;
      detect(chat ?? null);
    }).catch(() => { /* chat subscribe optional */ });
    // Listen for live chat actions (toolCallStart → set, toolCallComplete → clear)
    this.ahpChatUnsub = client.onNotification('action', (params) => {
      const env = params as { channel?: string; action?: Record<string, unknown> };
      if (env.channel !== chatUri) return;
      const action = env.action ?? {};
      if (action.type === 'chat/toolCallStart' && action.toolName === 'question_user') {
        const input = action.toolInput as { question?: string; options?: unknown[]; allowFreeform?: boolean } | undefined;
        const opts = (input?.options ?? []).map((o) => typeof o === 'string' ? o : (o as { label?: string })?.label ?? String(o));
        this.pendingQuestion = {
          questionId: action.toolCallId as string,
          question: input?.question ?? '',
          options: opts,
          allowFreeform: input?.allowFreeform ?? true,
        };
      } else if (action.type === 'chat/toolCallComplete' || action.type === 'chat/turnComplete') {
        this.pendingQuestion = null;
      }
    });
  }

  /** Show a friendly empty-state panel (binary missing / not yet connected) with a retry action. */
  private renderEmptyState(message: string, showSettingsLink: boolean, retryHandler?: () => void): void {
    this.screenEl.empty();
    const empty = this.screenEl.createDiv({ cls: 'pi-empty-state' });
    empty.createDiv({ cls: 'pi-empty-icon', text: '⌨️' });
    empty.createDiv({ text: message });
    const actions = empty.createDiv({ cls: 'pi-empty-actions' });
    const retryBtn = actions.createEl('button', { cls: 'pi-chat-btn', text: 'Retry' });
    retryBtn.addEventListener('click', () => { void (retryHandler ? retryHandler() : this.bootTerminal()); });
    if (showSettingsLink) {
      const settingsBtn = actions.createEl('button', { cls: 'pi-chat-btn', text: 'Open settings' });
      settingsBtn.addEventListener('click', () => this.openPluginSettings());
    }
  }

  // ─── xterm boot + PTY wiring ───────────────────────────────────────────────

  /**
   * Create + mount an xterm.js Terminal (FitAddon, WebLinks, Search, WebGL) on
   * the screen host. Shared by the PTY boot path (bootTerminal) and the AHP boot
   * path (bootAhpTerminal) so both surfaces use identical xterm setup.
   */
  private createXterm(fontFamily: string | undefined, fontSize: number | undefined, scrollback: number | undefined): Terminal {
    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    const term = new Terminal({
      fontFamily: fontFamily || 'Menlo, Monaco, "Courier New", monospace',
      fontSize: fontSize || 13,
      letterSpacing: 0,
      scrollback,
      allowProposedApi: true,
      cursorBlink: false,
      convertEol: false,
      macOptionIsMeta: true, // Option+Backspace/arrows → ESC-prefixed sequences pi's readline-style editor expects
      theme: this.buildXtermTheme(),
    });
    this.screenEl.empty();
    term.loadAddon(this.fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(this.searchAddon);
    term.open(this.screenEl);
    // Mobile touch scrolling: xterm's default touch gesture is text-selection,
    // not scrollback scrolling. A single-finger vertical drag should scroll the
    // terminal history (like a native mobile terminal), so we intercept vertical
    // drags on the screen container and translate them to term.scrollLines().
    // Horizontal or sub-threshold movement falls through to xterm (tap/selection).
    if (Platform.isMobile) {
      // Touch-to-pan anywhere in the terminal (like a note). xterm's .xterm-screen
      // sits on top and intercepts touch for text-selection in the bubble phase, so
      // we listen in the CAPTURE phase to fire first. Once a vertical drag is
      // detected we stopPropagation (block xterm selection) + scrollLines.
      let lastY = 0;
      let lastX = 0;
      let acc = 0;
      let isScrolling = false;
      const LINE_PX = Math.max(14, (fontSize ?? 13) * 1.4);
      const onStart = (e: TouchEvent) => {
        if (e.touches.length === 1) { lastY = e.touches[0].clientY; lastX = e.touches[0].clientX; acc = 0; isScrolling = false; }
      };
      const onMove = (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        const y = e.touches[0].clientY;
        const x = e.touches[0].clientX;
        const dy = lastY - y;
        if (!isScrolling && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(x - lastX) * 0.7) isScrolling = true;
        if (isScrolling) {
          e.preventDefault();
          e.stopPropagation();
          acc += dy;
          lastY = y;
          const lines = Math.trunc(acc / LINE_PX);
          if (lines !== 0) { term.scrollLines(lines); acc -= lines * LINE_PX; }
        }
      };
      this.screenEl.addEventListener('touchstart', onStart, { passive: true, capture: true });
      this.screenEl.addEventListener('touchmove', onMove, { passive: false, capture: true });
    }
    // Use the WebGL renderer when available to avoid the DOM renderer's
    // expensive main-thread layout work during terminal boot. Desktop-only:
    // mobile webviews (iOS WKWebView / Android) may not expose a compatible
    // WebGL context, so mobile falls back to the default DOM renderer.
    if (Platform.isDesktop) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
        this.webglAddon = webgl;
      } catch {
        /* fall back to the default DOM renderer */
      }
    }
    return term;
  }

  /** Set the AHP interactive terminal channel before the view boots. */
  setAhpTerminalChannel(uri: string): void {
    this.ahpTerminalUri = uri;
  }

  /**
   * Boot the terminal for AHP mode: create xterm and attach the
   * AhpTerminalAdapter to the plugin's active AHP client, which renders the
   * remote session's action stream (via attachActionMapper → onEvent) into the
   * terminal and forwards typed lines as new turns. No PTY / no local instance.
   * When `ahpTerminalUri` is set, the adapter boots in interactive terminal
   * (PTY) mode instead of chat-turn mode.
   */
  async rebootAhp(): Promise<void> { await this.bootAhpTerminal(); }

  private async bootAhpTerminal(): Promise<boolean> {
    let client = this.plugin.ahpClient;
    if (!client || client.state !== 'connected') {
      client = await this.plugin.ensureAhpClientReady();
    }
    if (!client || client.state !== 'connected') {
      this.statusText?.setText('AHP server not connected');
      this.renderEmptyState(
        'AHP server not connected — configure the server URL in plugin settings, then retry.',
        true,
        () => void this.maybeBoot(),
      );
      return false;
    }

    // Restore path: a fresh AhpClient has no subscription for this terminal URI,
    // so re-subscribe to establish the broker channel and refresh the snapshot
    // replay (cols/rows/scrollback). On the command-open path the client was
    // already subscribed before the view was created; the call is idempotent
    // and gives us the current snapshot.
    if (this.ahpTerminalUri) {
      try {
        const snap = await client.subscribe(this.ahpTerminalUri);
        const { initialCols, initialRows, initialContent } = extractTerminalSnapshot(snap);
        if (initialCols !== undefined) this.ahpInitialCols = initialCols;
        if (initialRows !== undefined) this.ahpInitialRows = initialRows;
        if (initialContent !== undefined) this.ahpInitialContent = initialContent;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isAhpError(err, -32002)) {
          // Session not found on the server — the saved URI is stale.
          this.renderEmptyState(
            'Saved AHP session no longer exists — open a new remote session.',
            false,
            () => void this.maybeBoot(),
          );
          return false;
        }
        if (isAhpError(err, -32000)) {
          // Server has no node-pty / the owning host's local PTY is down —
          // the session exists but no interactive terminal is available.
          this.renderEmptyState(
            'AHP: no interactive terminal on this server — open a new remote session or fix the server.',
            false,
            () => void this.maybeBoot(),
          );
          return false;
        }
        this.renderEmptyState(
          `AHP terminal subscribe failed: ${msg}`,
          true,
          () => void this.maybeBoot(),
        );
        return false;
      }
    }

    const settings = this.plugin.settings;
    this.term = this.createXterm(settings.terminalFontFamily, settings.terminalFontSize, settings.terminalScrollback);

    // If the server's subscribe snapshot carries the real PTY size that produced
    // the screenText replay, match that size BEFORE writing anything. Otherwise
    // the replay content is interpreted at the viewer's unrelated container
    // width and relative cursor movements corrupt the screen. This corruption is
    // intrinsic to the replay itself: screenText is generated server-side by a
    // real @xterm/headless terminal at its own size, so replaying it into a buffer
    // sized for the Obsidian client container garbles the visual reconstruction
    // even when there is no live supervisor and zero subsequent data.
    const { ahpInitialCols, ahpInitialRows } = this;
    const hasSnapshotSize =
      typeof ahpInitialCols === 'number' &&
      typeof ahpInitialRows === 'number' &&
      ahpInitialCols > 0 &&
      ahpInitialRows > 0;
    if (hasSnapshotSize) {
      this.term.resize(ahpInitialCols, ahpInitialRows);
    } else {
      // No size from the server: the only sensible source of truth is the local
      // Obsidian container, so fit() to it immediately (today's fit-first path).
      this.fitAddon?.fit();
    }

    // In read-only subagent mode, block normal keystrokes from reaching xterm
    // so the user can't type into the mirror. Browser shortcuts (Ctrl/Cmd) are
    // still allowed so copy/paste keep working.
    if (this.ahpReadOnly) {
      this.term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        return !!(e.ctrlKey || e.metaKey || e.altKey);
      });
    }

    // Wire future resize events early so any later container change notifies the
    // server. The initial size is dispatched explicitly in the fallback path below
    // instead of waiting for an asynchronous onResize event.
    if (this.ahpTerminalUri) {
      this.term.onResize(({ cols, rows }) => this.ahpAdapter?.resize(cols, rows));
    }

    const instance = this.plugin.instanceManager.getOrCreate(this.instanceId);
    instance.terminalView = this;
    // Re-register the AHP instance config so the icon + number show after a
    // reload (the ahpInstanceConfigs array starts empty on plugin load).
    this.plugin.registerAhpInstance(this.getDisplayText(), this.instanceId);
    this.ahpAdapter = new AhpTerminalAdapter(this.term, client, (state) => {
      // Mirror live turn state onto the instance + tab icon so the AHP terminal
      // reaches the same icon-state system as a local PTY terminal.
      instance.iconState = state;
      this.setVisualState(state);
      this.refreshTabIcon();
      this.plugin.instanceManager.notifyChanged();
    }, { terminalUri: this.ahpTerminalUri, terminalMode: this.ahpTerminalMode, readOnly: this.ahpReadOnly });

    // Fallback fit-first path: the adapter didn't exist when fit() ran, so send
    // the initial container size now. When a snapshot size is available we
    // skip this; the correct size was set above and any container-driven resize
    // will fire after the replay is written.
    if (!hasSnapshotSize && this.ahpTerminalUri) {
      this.ahpAdapter.resize(this.term.cols, this.term.rows);
    }

    // Attach BEFORE the snapshot replay: the adapter's "Connected to
    // interactive terminal" banner is written into xterm at the current cursor
    // position, and pi's TUI uses RELATIVE cursor movements that assume the
    // replayed content's screen state. Writing the banner after the replay
    // would shift the cursor and corrupt the first live redraw; writing it
    // first lets the replay (the full screen state) overwrite it cleanly.
    this.ahpAdapter.attach();
    // Subscribe to the chat channel to detect in-flight question_user tool calls
    // (the question + options) so the PromptPopout can render them.
    this.subscribeToChatForQuestions(client);

    // Replay the server's current-screen snapshot (produced by a real
    // @xterm/headless terminal + SerializeAddon server-side, not raw historical
    // bytes) into xterm at the snapshot size (or, in the fallback path, at the
    // container size). Matching the size it was serialized at is still required:
    // pi's TUI uses RELATIVE cursor movements that assume the replayed content's
    // width matches the buffer it's written into.
    if (this.ahpInitialContent && this.ahpInitialContent.length > 0) {
      this.term.write(this.ahpInitialContent);
    }

    // Only after the replay has been written at the snapshot size, adjust to
    // the actual Obsidian container. If the container differs from the snapshot
    // size this fires onResize, which dispatches a viewer-driven resize request
    // to the server and reflows the already-correct static replay.
    if (hasSnapshotSize) {
      this.fitAddon?.fit();
    }

    this.setStatus('connected');
    this.updateReadOnlyIndicator();
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.screenEl);
    return true;
  }

  private async bootTerminal(): Promise<void> {
    const settings = this.plugin.settings;

    // Mobile has no local pi PTY (no node-pty in the mobile webview). A
    // workspace-restored local terminal leaf must never try to boot the PTY —
    // show the AHP-remote empty state instead.
    if (Platform.isMobile) {
      this.statusText?.setText('Local pi terminal unavailable on mobile');
      this.renderEmptyState(
        'Local pi terminals are only available in the Obsidian desktop app. ' +
          'Use "pi: AHP — open or create remote session" to connect to a remote AHP session.',
        false,
      );
      return;
    }

    // Ensure the PTY client exists for this specific instance (creates it; does
    // NOT connect yet) so we can subscribe to its ANSI stream before spawning and
    // miss no early output. Checked before mounting xterm so we can show a
    // friendly empty-state instead of an inert blank terminal when the binary
    // isn't configured.
    const client = await this.plugin.instanceManager.ensurePtyClient(this.instanceId);
    if (!client) {
      this.statusText?.setText('pi binary not found — check settings');
      this.renderEmptyState('pi binary not found. Configure the binary path in settings, then retry.', true);
      return;
    }

    this.term = this.createXterm(settings.terminalFontFamily, settings.terminalFontSize, settings.terminalScrollback);

    // macOS Cmd-modified line-editing shortcuts have no standard terminal escape
    // sequence — real terminal apps (iTerm2, Terminal.app) translate them
    // internally before the shell ever sees them. xterm.js doesn't, so without
    // this handler Cmd+Backspace/Cmd+Left/Cmd+Right/Cmd+Delete are silently
    // swallowed (or fall through as a bare Backspace byte). Translate them to
    // the equivalent readline control codes, which pi's editor (readline-style)
    // already handles natively — the same codes bash/zsh use.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.metaKey || e.ctrlKey || e.altKey) return true;
      const client = this.getInstancePtyClient();
      if (!client || client.state !== 'connected') return true;
      switch (e.key) {
        case 'Backspace':  client.write('\x15'); return false; // Ctrl+U — kill to start of line
        case 'Delete':     client.write('\x0b'); return false; // Ctrl+K — kill to end of line
        case 'ArrowLeft':  client.write('\x01'); return false; // Ctrl+A — start of line
        case 'ArrowRight': client.write('\x05'); return false; // Ctrl+E — end of line
        default: return true;
      }
    });

    // Subscribe BEFORE connecting.
    this.unsubData = client.onData((d) => this.term?.write(d));
    this.unsubState = client.onStateChange((s) => this.setStatus(s));
    const instance = this.plugin.instanceManager.getOrCreate(this.instanceId);
    instance.terminalView = this;
    this.plugin.instanceManager.wireStateNotices(instance);

    // Keystrokes from xterm → PTY; resize → PTY.
    this.term.onData((d) => client.write(d));
    this.term.onResize(({ cols, rows }) => client.resize(cols, rows));

    // Image paste: xterm.js's built-in paste only forwards *text*. When the
    // clipboard holds an image (no text), nothing reaches the PTY and pi's
    // Ctrl+V `app.clipboard.pasteImage` keybinding never fires. Intercept the
    // paste event in capture phase and, for image-only pastes, send \x16 so pi
    // reads the real OS clipboard image (matching a native pi TUI session).
    const termTextarea = (this.term as any).textarea as HTMLElement | undefined;
    if (termTextarea) {
      const imgPasteHandler = (e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        let hasImage = false;
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith('image/')) { hasImage = true; break; }
        }
        if (!hasImage) return; // let xterm's default text paste run
        e.preventDefault();
        e.stopImmediatePropagation();
        const c = this.getInstancePtyClient();
        if (c && c.state === 'connected') c.write('\x16');
      };
      termTextarea.addEventListener('paste', imgPasteHandler, true);
      this.termPasteImageHandler = imgPasteHandler;
    }

    // Spawn the PTY if not already running, then sync its size to the viewport.
    if (client.state === 'disconnected') {
      try {
        await client.connect();
      } catch { /* state listener surfaces the crash */ }
    }
    requestAnimationFrame(() => {
      if (this.disposed) return;
      this.fitAddon?.fit();
      // Defer the PTY resize to the next frame so it doesn't force a layout
      // read synchronously in the same frame as the fit() write.
      requestAnimationFrame(() => {
        if (this.disposed || !this.term) return;
        client.resize(this.term.cols, this.term.rows);
      });
    });

    // Keep the PTY size in sync with the viewport.
    this.resizeObserver = new ResizeObserver(() => {
      if (this.disposed) return;
      this.scheduleFit();
    });
    this.resizeObserver.observe(this.screenEl);

    this.setStatus(client.state);
  }

  /** Live-update the terminal font size (called from settings). */
  setFontSize(px: number): void {
    if (!this.term) return;
    this.term.options.fontSize = px;
    this.scheduleFit();
  }

  /** Coalesce multiple fit() triggers into a single rAF to avoid redundant
   * xterm.js layout recalculations back-to-back. */
  /** Immediate, un-debounced fit — used by the visualViewport handler where
   *  we want the terminal to refit RIGHT NOW (the container height was just set)
   *  plus a 50ms follow-up for stale styles. */
  private doFit(): void {
    if (this.disposed) return;
    const w = this.screenEl?.clientWidth ?? 0;
    const h = this.screenEl?.clientHeight ?? 0;
    if (w === this.lastFitWidth && h === this.lastFitHeight) return;
    this.lastFitWidth = w;
    this.lastFitHeight = h;
    try { this.fitAddon?.fit(); } catch { /* container not ready */ }
  }

  private scheduleFit(): void {
    if (this.disposed) return;
    // Debounce: the mobile keyboard animates open over ~250ms, firing many
    // ResizeObserver events. Fitting on each one sends a stream of resize
    // actions to the broker → the pi TUI redraws repeatedly and the content
    // jumps (the "double offset" where the input scrolls off the top). Wait
    // for the resize to settle, then fit once.
    if (this.fitTimer) clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => {
      this.fitTimer = null;
      if (this.disposed) return;
      try { this.fitAddon?.fit(); } catch { /* container not ready */ }
    }, 200);
  }

  private buildXtermTheme(): { background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string } {
    const css = getComputedStyle(this.containerEl);
    const get = (v: string, fallback: string) => {
      const val = css.getPropertyValue(v).trim();
      return val || fallback;
    };
    return {
      background: get('--background-primary', '#1e1e1e'),
      foreground: get('--text-normal', '#dcddde'),
      cursor: get('--text-normal', '#dcddde'),
      cursorAccent: get('--background-primary', '#1e1e1e'),
      selectionBackground: get('--interactive-accent', '#7c5cff'),
    };
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  private setStatus(state: PtyClientState): void {
    if (!this.statusText) return;
    this.currentStatusState = state;
    const clsMap: Record<PtyClientState, string> = {
      connected:    'pi-status-connected',
      connecting:   'pi-status-disconnected',
      disconnected: 'pi-status-disconnected',
      reconnecting: 'pi-status-reconnecting',
      crashed:      'pi-status-crashed',
    };
    this.statusEl.className = `pi-terminal-status ${clsMap[state] ?? ''}`.trim();
    const labels: Record<PtyClientState, string> = {
      connected:    'connected',
      connecting:   'starting…',
      disconnected: 'disconnected',
      reconnecting: 'reconnecting…',
      crashed:      'crashed',
    };
    this.statusText.setText(labels[state] ?? state);
  }
}

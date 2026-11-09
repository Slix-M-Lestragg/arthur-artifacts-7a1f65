import { EventRef, MarkdownView, Modal, Notice, Platform, Plugin, TFile, Workspace, WorkspaceLeaf } from 'obsidian';
import { ObsidianPiSettings, PiInstanceConfig } from './types';
import { AgentNotifier } from './notifications/AgentNotifier';
import { InstanceManager } from './instance/InstanceManager';
import { HiddenNoteRegistry } from './utils/hiddenNote';
import { ahpTokenOverrideActive, sttTokenOverrideActive, envAhpServerToken, envSttToken } from './utils/envTokens';
import { normalizeSettings } from './utils/normalizeSettings';
import { instanceSessionsDir, instancePromptNotePath } from './instance/InstancePaths';
import {
  addInstanceInteractive,
  confirmAction,
  removeInstanceInteractive,
  renameInstanceInteractive,
} from './instance/instanceActions';
import type { BinaryInfo, BinaryError } from './binary';
import { ObsidianPiSettingsTab } from './views/SettingsTab';
import { TerminalView, VIEW_TYPE_PI_TERMINAL } from './views/TerminalView';
import { FarmView, VIEW_TYPE_FARM_VIEW } from './views/FarmView';
import { InstancePickerModal } from './views/InstancePickerModal';
import { AhpSessionBrowserModal } from './views/AhpSessionBrowserModal';
import { confirmLiveMirrorSession, isLiveMirrorSession } from './views/AhpSessionPickerModal';
import { TextInputModal } from './views/TextInputModal';
import { dispatchTaskToWorker } from './transport/swarmDispatch';
import { showDispatchResult } from './views/DispatchResultModal';
import { registerPiTerminalIcons } from './views/TerminalIcon';
import { attachRibbonInstanceHub } from './views/RibbonInstanceHub';
import { PromptPopout } from './views/PromptPopout';
import type { RpcClientState, PiClient } from './transport/RpcClient';
import { AhpClient, AHP_PROTOCOL_VERSION, type SessionSummary } from './transport/AhpClient';
import { isAhpError } from './transport/AhpError';
import { DEFAULT_AHP_SERVER_URL } from './constants';
import type { HostAgentClient } from './transport/HostAgentClient';
import { deriveAhpTerminalUriFromChat } from './transport/ahpUri';
import { matchLocalRelaySession } from './transport/localRelay';
import { errorMessage } from './utils/errors';
import { createHostedAhpSession, extractTerminalSnapshot } from './transport/attachAhpSession';
import type { JsonRunnerOptions } from './transport/JsonRunner';
import { VaultContext } from './vault/VaultContext';
import type { PiCommandStep } from './views/PiCommandModal';
import { WikilinkSuggester } from './views/WikilinkSuggester';
import { CommandSuggester } from './views/CommandSuggester';
import { TextareaEditorAdapter } from './views/suggest/TextareaEditorAdapter';
import { FileAtSuggester } from './views/suggest/FileAtSuggester';
import type { AuthBridge } from './transport/AuthBridge';
import type { MenubarCoordinator } from './menubar/MenubarCoordinator';

// ── Terminal leaf helpers ───────────────────────────────────────────────────
// Obsidian defers background/unfocused leaves (since 1.7.2): a deferred leaf
// holds a DeferredView placeholder instead of the real view, so
// `leaf.view instanceof TerminalView` is false for an unfocused terminal tab.
// Read the bound instance id from the leaf's *persisted view state* instead —
// it is preserved for both loaded and deferred leaves, so unfocused terminals
// are correctly counted as restored (keeping their pending session-resume path)
// and correctly reused (no duplicate leaves) on manual open.

/** Return the instance id bound to a terminal leaf, or undefined if the leaf
 *  isn't a terminal or has no bound instance. Works for deferred leaves. */
function terminalLeafInstanceId(leaf: WorkspaceLeaf): string | undefined {
  const vs = leaf.getViewState();
  if (vs?.type !== VIEW_TYPE_PI_TERMINAL) return undefined;
  return (vs.state as { instanceId?: string } | undefined)?.instanceId;
}

/** Find the terminal leaf bound to a given instance id (loaded or deferred). */
function findTerminalLeafForInstance(workspace: Workspace, instanceId: string): WorkspaceLeaf | null {
  let found: WorkspaceLeaf | null = null;
  workspace.iterateAllLeaves((leaf) => {
    if (found) return;
    const vs = leaf.getViewState();
    if (vs?.type !== VIEW_TYPE_PI_TERMINAL) return;
    if (terminalLeafInstanceId(leaf) === instanceId) found = leaf;
  });
  return found;
}

/** Find the AHP terminal leaf already bound to a given session terminal URI
 *  (loaded or deferred). Mirrors findTerminalLeafForInstance so attaching to
 *  the same AHP session reuses its leaf instead of creating a duplicate tab. */
function findAhpTerminalLeafForUri(workspace: Workspace, terminalUri: string): WorkspaceLeaf | null {
  let found: WorkspaceLeaf | null = null;
  workspace.iterateAllLeaves((leaf) => {
    if (found) return;
    const vs = leaf.getViewState();
    if (vs?.type !== VIEW_TYPE_PI_TERMINAL) return;
    const st = vs.state as { ahp?: boolean; ahpTerminalUri?: string } | undefined;
    if (st?.ahp && st.ahpTerminalUri === terminalUri) found = leaf;
  });
  return found;
}

export default class ObsidianPiPlugin extends Plugin {
  settings!: ObsidianPiSettings;

  /** Cached result of the last successful binary detection. */
  binaryInfo: BinaryInfo | null = null;

  /** Best-effort path to the external `fd` binary; null if not found. */
  fdPath: string | null = null;

  /**
   * Runtime API key (authStrategy === 'runtime-key').
   * Never persisted — held in memory only.
   */
  runtimeApiKey = '';

  /** Active transport client (local RPC subprocess or remote AHP WebSocket). */
  rpcClient: PiClient | null = null;

  /** Active remote AHP client (Variation A thin-client). Separate from the
   *  local pi RPC so opening a remote AHP terminal does not tear down local
   *  pi terminal instances. Rendered into a TerminalView in AHP mode. */
  ahpClient: AhpClient | null = null;
  /** In-flight promise shared by concurrent callers of `ensureAhpCatalogConnection`
   *  so reload-time races (onload scan, restored leaves, onOpen) all await a
   *  single connect handshake instead of disposing each other's clients. */
  private ahpConnectPromise: Promise<AhpClient | null> | null = null;
  /** In-flight promise shared by concurrent callers of `connectRpc` — same
   *  dedup as ahpConnectPromise. Without it, racing reconnects (startup scan,
   *  manual reconnect command, session-open paths) each built a fresh RpcClient
   *  and spawned orphaned pi subprocesses (AUDIT §3 finding 2). */
  private rpcConnectPromise: Promise<void> | null = null;

  /** M3 host-agent relay: registers this Mac's local pi instances with the
   *  Farm View server (hostAgent.* wire contract). Constructed ONLY on
   *  desktop AND when settings.hostAgentEnabled — mobile never creates it. */
  hostAgentClient: HostAgentClient | null = null;
  /** Title shown in the AHP terminal tab/toolbar for the active remote session. */
  ahpSessionTitle = '';
  /** When set, the next AHP terminal view boots in interactive PTY mode on this channel. */
  ahpTerminalUri?: string;
  /** When the next AHP terminal view boots in PTY mode, this records whether
   *  the real PTY is externally supervised (`external`) or server-hosted
   *  (`server-spawned`). Used to stop the viewer fighting a physical desktop
   *  terminal for resize authority. */
  ahpTerminalMode?: 'external' | 'server-spawned' | 'none';
  /** Optional initial terminal size carried from the server's subscribe snapshot.
   *  Applied to the local xterm before any PTY data arrives to keep the local
   *  buffer width in sync with the real PTY's actual width. */
  ahpInitialCols?: number;
  ahpInitialRows?: number;
  /** Optional initial terminal content carried from the server's subscribe snapshot.
   *  Replayed into the local xterm before any live PTY data arrives so the
   *  screen already matches the real terminal and relative cursor redraws work. */
  ahpInitialContent?: string;
  /** Synthetic PiInstanceConfig for the active remote-AHP instance (runtime
   *  only, not persisted). Appended to settings.instances for the UI list so
   *  the AHP terminal flows through the ribbon hub, numbered tab icon, and
   *  per-instance command like a local instance. */
  ahpInstanceConfigs: PiInstanceConfig[] = [];
  private ahpCounter = 0;

  /** Per-instance terminal lifecycle manager (Phase 10). Created in onload. */
  instanceManager!: InstanceManager;

  /** Optional refresh hook set by attachRibbonInstanceHub; rebuilds the hover
   *  hub if it's currently visible so add/rename/remove are reflected immediately. */
  refreshRibbonHub?: () => void;

  /** Opens hidden (non-indexed) prompt notes under .obsidian/plugins/<id>/prompts/
   *  as MarkdownViews via synthetic TFiles injected into vault.fileMap. */
  hiddenNotes!: HiddenNoteRegistry;

  /** Return the PromptPopout for the instance whose terminal view is active,
   *  falling back to the default instance when no pi terminal is focused. */
  private activeInstancePromptPopout(): PromptPopout {
    const activeView = this.app.workspace.getActiveViewOfType(TerminalView);
    const instanceId = activeView?.instanceId ?? 'default';
    return this.instanceManager.ensurePromptPopout(instanceId);
  }

  /** Injected `<style>` that hides the prompt note in the file explorer (pure CSS — no observers). */
  private promptHiderStyleEl: HTMLStyleElement | null = null;

  /** Dynamic command ids registered for each configured instance. */
  private registeredInstanceCommandIds: string[] = [];

  /** Snapshot of instances used to detect changes when saving settings. */
  private lastInstancesJson = '';

  /** Vault context helper — wikilink resolution, note capture, output application. */
  vaultContext: VaultContext | null = null;

  /** Agent lifecycle notifier (Phase 11). Exposed so other modules can call handle(). */
  agentNotifier!: AgentNotifier;

  /** macOS menu-bar (tray) coordinator (Phase 14). Null on non-macOS or when
   *  the user has not opted in via `settings.menubarEnabled`. */
  menubarCoordinator: MenubarCoordinator | null = null;

  /**
   * Auth/model/settings SDK bridge (Phase 8) — spawned on-demand when a
   * Provider/Settings/Model UI surface opens, disposed when that surface closes.
   * Unlike rpcClient/ptyClient this is intentionally short-lived, not kept
   * alive for the whole plugin lifetime. See transport/AuthBridge.ts.
   */
  authBridge: AuthBridge | null = null;
  private authBridgeRefCount = 0;
  /** In-flight ensureAuthBridge() call — shared so concurrent callers don't spawn two bridges. */
  private authBridgePromise: Promise<AuthBridge | null> | null = null;

  /** The MarkdownView the user was last working in (before switching to chat). */
  lastEditorView: MarkdownView | null = null;

  /** Show a Notice and return false when the current platform cannot run
   *  local-spawn capabilities. Used by command callbacks so non-desktop
   *  attempts are refused cleanly instead of silently no-oping. */
  private requireDesktopFor(actionName: string): boolean {
    if (Platform.isDesktop) return true;
    new Notice(`obsidian-pi: ${actionName} is only available in the Obsidian desktop app.`, 6000);
    return false;
  }

  /** Refuse a local-pi-only action on mobile with a remote-AHP hint. Used as a
   *  belt-and-suspenders guard on local-pi commands/UI that don't already route
   *  through requireDesktopFor, so mobile never accidentally hits a local-pi path. */
  private requireLocalPiFor(actionName: string): boolean {
    if (Platform.isDesktop) return true;
    new Notice(`obsidian-pi: ${actionName} is not available on mobile — use a remote AHP session instead.`, 6000);
    return false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();
    this.agentNotifier = new AgentNotifier(() => this.settings);
    // Terminal-mode question answer channel: a notification reply is forwarded
    // to the owning instance's PTY as a `pi:answer:` APC marker, which the
    // obsidian-bridge proxy feeds back to the in-flight question_user panel.
    this.agentNotifier.onAnswer = (instanceId, questionId, answer, wasCustom) => {
      if (!Platform.isDesktop) return;
      this.instanceManager.get(instanceId)?.ptyClient?.sendQuestionAnswer(questionId, answer, wasCustom);
    };
    this.instanceManager = new InstanceManager(this);
    this.addSettingTab(new ObsidianPiSettingsTab(this.app, this));

    // Restore the last active terminal session across Obsidian restarts. We set
    // the pending resume path BEFORE the terminal view boots (which happens
    // during workspace restore, after onload) so the first PtyClient spawn
    // loads this session via `--session <path>` instead of starting fresh.
    if (Platform.isDesktop && this.settings.restoreSessionOnRestart) {
      const { newestSessionFileInDir } = await import('./transport/sessionFiles');
      const fs = require('fs') as typeof import('fs');
      for (const cfg of this.settings.instances) {
        const instance = this.instanceManager.getOrCreate(cfg.id);
        let resumePath: string | null =
          instance.config.lastSessionFile ?? (cfg.id === 'default' ? this.settings.lastTerminalSessionFile : null) ?? null;
        if (!resumePath) {
          // First load with the persistence feature (nothing recorded yet) —
          // fall back to the newest terminal session file on disk so the most
          // recent session is restored right away instead of starting fresh.
          resumePath = newestSessionFileInDir(instanceSessionsDir(this, instance.config));
        }
        if (resumePath) {
          try {
            if (fs.existsSync(resumePath)) {
              instance.pendingResumeSessionPath = resumePath;
            }
          } catch { /* ignore — start a fresh terminal session */ }
        }
      }
    }

    // Register the terminal view type (xterm.js + PTY-backed pi interactive mode).
    this.registerView(VIEW_TYPE_PI_TERMINAL, (leaf) => new TerminalView(leaf, this));

    // Register the Farm view (AHP session catalogue table).
    this.registerView(VIEW_TYPE_FARM_VIEW, (leaf) => new FarmView(leaf, this));

    // Create one PromptPopout per configured instance (Phase 10), and ensure
    // each instance has its own dedicated prompt note visible in the vault.
    // Desktop-only: prompt popouts are the composing surface for the LOCAL pi
    // PTY — mobile uses the AHP-remote path and never creates them.
    if (Platform.isDesktop) {
      for (const instance of this.settings.instances) {
        const inst = this.instanceManager.getOrCreate(instance.id);
        inst.promptPopout = new PromptPopout(this.app, this, instance.id);
      }
      // Migrate the default instance's legacy prompt note (settings.promptNotePath)
      // to its name-based path before ensuring every instance has a dedicated note.
      this.hiddenNotes = new HiddenNoteRegistry(this.app.vault);
      await this.migrateDefaultPromptNote();
      await this.instanceManager.ensureAllPromptNotes();
    }


    // Vault context helper.
    this.vaultContext = new VaultContext(this.app);

    // Track the last MarkdownView the user was editing in — used by apply-output
    // to target the right note even when the chat view is focused.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf | null) => {
        if (leaf?.view instanceof MarkdownView) {
          this.lastEditorView = leaf.view;
        }
      }),
    );

    // Bi-directional prompt-note ↔ instance-name sync: when the user renames a
    // 'pi prompt — <name>.md' note in the file explorer, update its instance's
    // display name to match (the reverse direction is handled in applyRename).
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) void this.onPromptNoteRenamed(file, oldPath);
      }),
    );

    // Detect binary and connect the local RPC subprocess only on desktop.
    // The remote AHP client path does not need a local pi binary.
    if (Platform.isDesktop) {
      await this.detectBinary();
      if (this.binaryInfo) {
        this.connectRpc().catch((err) =>
          new Notice(`pi RPC failed to start: ${errorMessage(err)}`, 8000),
        );
      }
      // M3 host-agent relay: desktop-only + opt-in. The module is loaded via a
      // desktop-gated dynamic import so its scope never runs on mobile.
      if (this.settings.hostAgentEnabled) {
        void this.startHostAgentClient();
      }
    }

    // Mobile mode: no local pi binary — guide the user to the AHP-remote path
    // on first load (when the server URL is still the desktop-local default).
    if (Platform.isMobile) {
      const url = this.settings.ahpServerUrl.trim() || DEFAULT_AHP_SERVER_URL;
      if (url === DEFAULT_AHP_SERVER_URL) {
        new Notice(
          'obsidian-pi: mobile mode — set your AHP server URL in settings, then run "pi: AHP — open or create remote session".',
          8000,
        );
      }
    }

    this.addCommand({
      id: 'check-pi-binary',
      name: 'Check pi binary',
      callback: () => { if (this.requireDesktopFor('Check pi binary')) void this.detectBinary(true); },
    });

    this.addCommand({
      id: 'reconnect-rpc',
      name: 'Reconnect pi RPC',
      callback: () => { if (this.requireDesktopFor('Reconnect pi RPC')) void this.connectRpc(true); },
    });

    this.addCommand({
      id: 'ahp-open-or-create-session',
      name: 'pi: AHP — open or create remote session',
      icon: 'plug',
      callback: () => void this.openOrCreateAhpSession(),
    });

    this.addCommand({
      id: 'open-farm-view',
      name: 'pi: Open Farm view',
      icon: 'tractor',
      callback: () => void this.activateFarmView(),
    });

    this.addCommand({
      id: 'dispatch-task-to-worker',
      name: 'pi: Dispatch task to swarm worker',
      icon: 'send',
      callback: () => void this.dispatchTaskToWorkerCommand(),
    });

    this.addCommand({
      id: 'debug-menubar',
      name: 'Debug menu bar (tray)',
      callback: () => { if (this.requireDesktopFor('Debug menu bar')) this.debugMenubar(); },
    });

    this.addCommand({
      id: 'test-question-notification',
      name: 'Test question notification',
      callback: () => {
        if (!this.requireDesktopFor('Test question notification')) return;
        void this.agentNotifier.showInteractive({
          title: 'pi needs input (test)',
          body: 'Which approach?\n\n1. Option A\n2. Option B\n3. Option C',
          actions: ['Option A', 'Option B', 'Option C'],
          reply: true,
          replyPlaceholder: 'Type an answer or option number…',
        }).then((result) => {
          console.log('[obsidian-pi] test notification result', result);
          new Notice(`Notification result: ${JSON.stringify(result)}`, 6000);
        });
      },
    });

    this.addCommand({
      id: 'open-pi-terminal',
      name: 'Open pi terminal',
      callback: () => {
        if (!this.requireDesktopFor('Open pi terminal')) return;
        if (this.settings.instances.length > 1) {
          new InstancePickerModal(this.app, this, (id) => void this.activateTerminalView(id)).open();
        } else {
          void this.activateTerminalView('default');
        }
      },
    });

    this.refreshInstanceCommands();
    this.refreshTerminalIcons();

    this.addCommand({
      id: 'add-pi-instance',
      name: 'pi: Add instance…',
      callback: () => {
        if (!this.requireDesktopFor('Add pi instance')) return;
        void addInstanceInteractive(this).then((instance) => {
          if (!instance) return;
          new Notice(`Added pi instance "${instance.name}"`);
          confirmAction(this.app, 'Open terminal now?', `Open a terminal for "${instance.name}"?`).then((open) => {
            if (open) void this.activateTerminalView(instance.id);
          });
        });
      },
    });

    this.addCommand({
      id: 'remove-pi-instance',
      name: 'pi: Remove instance…',
      callback: () => { if (this.requireDesktopFor('Remove pi instance')) void removeInstanceInteractive(this); },
    });

    this.addCommand({
      id: 'rename-pi-instance',
      name: 'pi: Rename instance…',
      callback: () => { if (this.requireDesktopFor('Rename pi instance')) void renameInstanceInteractive(this); },
    });

    this.addCommand({
      id: 'reconnect-pi-terminal',
      name: 'Reconnect pi terminal',
      callback: () => { if (this.requireDesktopFor('Reconnect pi terminal')) void this.connectTty(true); },
    });

    this.addCommand({
      id: 'open-pi-prompt-popout',
      name: 'Open floating pi prompt',
      callback: () => {
        if (!this.requireLocalPiFor('Open floating pi prompt')) return;
        void this.activeInstancePromptPopout()?.openPopout();
      },
    });

    this.addCommand({
      id: 'dock-pi-prompt',
      name: 'Dock pi prompt in main window',
      callback: () => {
        if (!this.requireLocalPiFor('Dock pi prompt')) return;
        void this.activeInstancePromptPopout()?.openDocked();
      },
    });

    this.addCommand({
      id: 'toggle-pi-prompt-surface',
      name: 'Toggle pi prompt surface (popout / docked)',
      callback: () => {
        if (!this.requireLocalPiFor('Toggle pi prompt surface')) return;
        void this.activeInstancePromptPopout()?.toggleSurface();
      },
    });

    this.addCommand({
      id: 'submit-pi-prompt',
      name: 'Submit pi prompt',
      hotkeys: [{ modifiers: ['Mod'], key: 'Enter' }],
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        const matchingInstance = this.settings.instances.find(
          (cfg) => activeFile?.path === instancePromptNotePath(this, cfg),
        );
        if (!matchingInstance) return false;
        if (!checking) {
          if (!this.requireDesktopFor('Submit pi prompt')) return true;
          const popout = this.instanceManager.getPromptPopout(matchingInstance.id);
          void popout?.submit();
        }
        return true;
      },
    });

    // ── pi maintenance: update pi / extensions ─────────────────────────────
    this.addCommand({
      id: 'pi-update',
      name: 'Update pi',
      callback: () => { if (this.requireDesktopFor('Update pi')) void this.runPiUpdate(true, false); },
    });
    this.addCommand({
      id: 'pi-update-extensions',
      name: 'Update pi extensions',
      callback: () => { if (this.requireDesktopFor('Update pi extensions')) void this.runPiUpdate(false, true); },
    });
    this.addCommand({
      id: 'pi-update-all',
      name: 'Update pi and extensions',
      callback: () => { if (this.requireDesktopFor('Update pi and extensions')) void this.runPiUpdate(true, true); },
    });

    // ── Phase 4: vault context commands ────────────────────────────────────

    this.addCommand({
      id: 'send-active-note',
      name: 'Send active note to pi',
      editorCallback: async (editor, ctx) => {
        if (!this.requireDesktopFor('Send active note to pi')) return;
        const file = ctx.file;
        if (!file) return;
        const content = await this.app.vault.read(file);
        const resolved = this.vaultContext?.replaceWikilinks(content) ?? content;
        const promptContent = `Here is the content of my note "${file.basename}" (at ${this.vaultContext?.getVaultPath()}/${file.path}):\n\n---\n${resolved}\n---`;
        await this.sendToActiveTerminal(promptContent);
      },
    });

    this.addCommand({
      id: 'send-selection',
      name: 'Send selection to pi',
      editorCallback: async (editor, ctx) => {
        if (!this.requireDesktopFor('Send selection to pi')) return;
        const selection = editor.getSelection();
        if (!selection) {
          new Notice('No text selected', 2000);
          return;
        }
        const file = ctx.file;
        const filename = file?.basename ?? 'unknown';
        const resolved = this.vaultContext?.replaceWikilinks(selection) ?? selection;
        const promptContent = `Here is the selected text from my note "${filename}":\n\n---\n${resolved}\n---`;
        await this.sendToActiveTerminal(promptContent);
      },
    });

    // Ribbon icon — opens the pi terminal on desktop; on mobile (no local pi)
    // it opens the AHP remote-session picker instead. The instance hub (add/
    // rename/remove local instances) is desktop-only.
    const ribbonEl = this.addRibbonIcon(
      'squircle-dashed',
      Platform.isDesktop ? 'Open pi terminal' : 'Connect to AHP remote session',
      () => {
        if (Platform.isDesktop) {
          if (this.settings.instances.length > 1) {
            new InstancePickerModal(this.app, this, (id) => void this.activateTerminalView(id)).open();
          } else {
            void this.activateTerminalView('default');
          }
        } else {
          void this.openOrCreateAhpSession();
        }
      },
    );
    if (Platform.isDesktop) {
      attachRibbonInstanceHub(ribbonEl, this);
    }

    // ── Phase 14: macOS menu-bar (tray) aggregator ────────────────────────
    this.startMenubar();

    // ── Phase 5: headless / note-triggered operations ────────────────────────

    // Register `pi` codeblock processor — renders a “Run” button + prompt preview in reading view.
    this.registerMarkdownCodeBlockProcessor('pi', (source, el, ctx) => {
      el.empty();
      el.addClass('pi-codeblock');

      // Parse the source to show a prompt preview.
      const parsed = this.parseCodeblockSource(source);

      // Toolbar row: prompt toggle + Run button.
      const toolbar = el.createDiv({ cls: 'pi-codeblock-toolbar' });

      // Prompt toggle — custom span (not <details>) so the button sits right next to it.
      if (parsed.prompt) {
        const toggle = toolbar.createEl('span', { cls: 'pi-codeblock-prompt-toggle', text: '📋 Prompt' });
        const previewBody = el.createDiv({ cls: 'pi-codeblock-prompt-body' });
        previewBody.style.display = 'none';
        const pre = previewBody.createEl('pre');
        let previewText = parsed.prompt;
        if (parsed.includeNote) previewText += '\n\n[Note content will be included as context]';
        if (parsed.model) previewText += `\n[Model: ${parsed.model}]`;
        pre.setText(previewText);
        toggle.addEventListener('click', () => {
          const isOpen = previewBody.style.display !== 'none';
          previewBody.style.display = isOpen ? 'none' : 'block';
          toggle.setText(isOpen ? '📋 Prompt' : '▼ Prompt');
        });
      }

      // Run button (right after the toggle).
      const btn = toolbar.createEl('button', { text: '▶', cls: 'pi-codeblock-run' });
      btn.setAttribute('aria-label', 'Run pi codeblock');
      btn.title = 'Run pi codeblock';
      btn.addEventListener('click', () => {
        if (!this.requireDesktopFor('Run pi codeblock')) return;
        const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
        const lineStart = ctx.getSectionInfo(el)?.lineStart;
        this.runHeadless(source, file instanceof TFile ? file : null, lineStart);
      });
    });

    // Command: Run frontmatter pi-trigger from the active note.
    this.addCommand({
      id: 'run-pi-trigger',
      name: 'Run pi trigger (frontmatter)',
      callback: () => { if (this.requireDesktopFor('Run pi trigger')) void this.runFrontmatterTrigger(); },
    });

    // Command: Run a one-shot prompt (type it in a modal).
    this.addCommand({
      id: 'run-pi-prompt',
      name: 'Run pi one-shot prompt',
      callback: () => { if (this.requireDesktopFor('Run pi one-shot prompt')) this.runOneShotModal(); },
    });

    // Command: Run the first `pi` codeblock in the active note.
    this.addCommand({
      id: 'run-pi-codeblock',
      name: 'Run pi codeblock in active note',
      callback: () => { if (this.requireDesktopFor('Run pi codeblock in active note')) void this.runFirstCodeblock(); },
    });

    // Hide the scratch prompt note from the file explorer once the layout is ready.
    this.app.workspace.onLayoutReady(() => {
      this.setPromptNoteHidden(this.settings.hidePromptNoteInExplorer);
      // The prompt editor is closed on unload so it isn't restored as a stale,
      // disconnected pane. As a guarantee, ensureFreshOnLoad polls for ~3s
      // detaching any prompt-note leaf Obsidian did (asynchronously) restore,
      // then spawns one fresh editor if auto-open is enabled (Phase 9) — so you
      // never end up with a duplicate restored + spawned window.
      for (const cfg of this.settings.instances) {
        const popout = this.instanceManager.getPromptPopout(cfg.id);
        popout?.ensureFreshOnLoad(this.settings.promptOpenOnLoad);
      }
      // If a terminal leaf was not restored as part of the workspace for a
      // given instance, drop that instance's pending session-resume path so a
      // later manual open starts fresh rather than unexpectedly resuming a stale
      // session.
      //
      // IMPORTANT: enumerate leaves via iterateAllLeaves + getViewState() rather
      // than `leaf.view instanceof TerminalView`. Obsidian defers background
      // leaves (DeferredView placeholder), so the unfocused terminal tab's view
      // is NOT a TerminalView at this point — the instanceof check would wrongly
      // mark it as unrestored and drop its resume path, losing persistency for
      // every terminal except the focused one after a reload.
      const restoredIds = new Set<string>();
      this.app.workspace.iterateAllLeaves((leaf) => {
        const vs = leaf.getViewState();
        if (vs?.type !== VIEW_TYPE_PI_TERMINAL) return;
        const id = terminalLeafInstanceId(leaf);
        if (id) restoredIds.add(id);
      });
      for (const instance of this.instanceManager.all()) {
        if (!restoredIds.has(instance.config.id)) {
          instance.pendingResumeSessionPath = null;
        }
      }
      // If any restored terminal leaf is a remote AHP session, eagerly connect
      // the shared AhpClient so those leaves can re-attach to their live server-
      // side PTY as soon as the client is ready. The TerminalViews themselves
      // listen for `ahp-client-ready` to retry boot.
      let hasRestoredAhpLeaf = false;
      try {
        this.app.workspace.iterateAllLeaves((leaf) => {
          const vs = leaf.getViewState();
          if (vs?.type !== VIEW_TYPE_PI_TERMINAL) return;
          const st = vs.state as { ahp?: boolean } | undefined;
          if (st?.ahp) hasRestoredAhpLeaf = true;
        });
      } catch { /* best-effort: never block plugin load */ }
      if (hasRestoredAhpLeaf) {
        void this.ensureAhpClientReady();
      }
    });

    console.log('obsidian-pi loaded');
  }

  async onunload(): Promise<void> {
    // Stop the menu-bar coordinator FIRST and defensively: if anything below
    // throws, we still want the tray destroyed before this renderer tears
    // down (a leaked tray is a main-process object that survives a renderer
    // reload — see MENUBAR_TRAY_REGISTRY_PROP in MenubarIcon.ts for the
    // belt-and-suspenders self-healing fallback in case this step is skipped).
    try {
      await this.menubarCoordinator?.stop();
    } catch (err) {
      console.warn('[obsidian-pi] menubar coordinator failed to stop cleanly', err);
    }
    this.menubarCoordinator = null;

    // M3 host-agent relay: graceful hostAgent.unregister + disconnect BEFORE
    // the per-instance PTY teardown below.
    await this.stopHostAgentClient();

    // Capture each instance's active terminal session file before tearing down
    // the PTY so every instance can resume on the next Obsidian restart.
    try {
      for (const instance of this.instanceManager.all()) {
        await this.instanceManager.recordTerminalSessionFile(instance);
      }
    } catch { /* non-fatal */ }
    await this.rpcClient?.dispose();
    this.rpcClient = null;
    await this.ahpClient?.dispose();
    this.ahpClient = null;
    this.unregisterAhpInstance();
    // Tear down all per-instance terminal/popout/PTY state. disposeAll now
    // awaits each PTY kill (bounded by PtyClient's own SIGTERM→SIGKILL grace);
    // onunload can't await, so fire-and-forget with the rejection contained
    // inside dispose().
    void this.instanceManager?.disposeAll();
    this.authBridge?.dispose();
    this.authBridge = null;
    this.authBridgeRefCount = 0;
    this.stopPromptNoteHider();
    this.hiddenNotes?.cleanup();
    this.vaultContext = null;
    console.log('obsidian-pi unloaded');
  }

  // ── Auth/model/settings SDK bridge (Phase 8) ──────────────────────────────────────

  /**
   * Acquire the auth bridge, spawning it on first use. Ref-counted: callers
   * (Provider/Settings/Model panels) MUST call releaseAuthBridge() when their
   * UI closes so the subprocess is torn down once nothing needs it.
   * Returns null (with a Notice) if the SDK can't be located from the current
   * binaryInfo (e.g. a standalone compiled `pi` binary rather than a Node script).
   */
  async ensureAuthBridge(): Promise<AuthBridge | null> {
    if (!this.requireDesktopFor('Open pi settings/model bridge')) return null;
    if (this.authBridge) {
      this.authBridgeRefCount++;
      return this.authBridge;
    }

    // Concurrent callers (e.g. the terminal's Model and Settings panels opened
    // in quick succession) share one spawn — otherwise the second overwrites
    // this.authBridge and the first subprocess leaks.
    if (this.authBridgePromise) {
      const bridge = await this.authBridgePromise;
      if (bridge) this.authBridgeRefCount++;
      return bridge;
    }
    this.authBridgePromise = this.spawnAuthBridge();
    try {
      return await this.authBridgePromise;
    } finally {
      this.authBridgePromise = null;
    }
  }

  /** Internal: detect, spawn and connect a fresh auth bridge (first reference). */
  private async spawnAuthBridge(): Promise<AuthBridge | null> {
    const authBridgeMod = await import('./transport/AuthBridge');
    const path = require('path') as typeof import('path');
    if (!this.binaryInfo) {
      await this.detectBinary(true);
    }
    const sdkIndexPath = authBridgeMod.resolveSdkIndexPath(this.binaryInfo);
    if (!sdkIndexPath) {
      new Notice(
        'pi auth/settings management requires pi installed as a Node script ' +
          '(npm global install) — not available for this binary configuration.',
        6000,
      );
      return null;
    }
    const nodeExe = this.binaryInfo?.nodeExe;
    if (!nodeExe) {
      new Notice('Could not resolve a Node.js executable for the auth bridge.', 6000);
      return null;
    }

    const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath ?? '';
    const pluginDir = this.manifest.dir ?? '.obsidian/plugins/obsidian-pi';
    const pluginDirAbs = path.join(vaultPath, pluginDir);
    const bridge = new authBridgeMod.AuthBridge(sdkIndexPath, {
      nodeExe,
      pluginDirAbs,
      cwd: this.settings.vaultAsCwd && vaultPath ? vaultPath : undefined,
      agentDir: this.settings.agentDir || undefined,
    });
    try {
      await bridge.connect();
    } catch (err) {
      // connect() spawns the child before pinging — make sure a half-started
      // bridge doesn't leak when the ping fails/times out.
      bridge.dispose();
      new Notice(`Failed to start auth bridge: ${errorMessage(err)}`, 8000);
      return null;
    }
    this.authBridge = bridge;
    this.authBridgeRefCount = 1;
    return bridge;
  }

  /** Release a reference acquired via ensureAuthBridge(); disposes once the count reaches zero. */
  releaseAuthBridge(): void {
    if (!this.authBridge) return;
    this.authBridgeRefCount = Math.max(0, this.authBridgeRefCount - 1);
    if (this.authBridgeRefCount === 0) {
      this.authBridge.dispose();
      this.authBridge = null;
    }
  }

  // ── Host agent relay (M3) ──────────────────────────────────────────────────────

  /** The effective AHP farm token: `AHP_SERVER_TOKEN` env var when set,
   *  otherwise the settings value. Always prefer this over reading
   *  `settings.ahpServerToken` directly. */
  effectiveAhpToken(): string {
    return envAhpServerToken() ?? this.settings.ahpServerToken;
  }

  /** The effective STT bearer token: `STT_TOKEN`/`WHISPER_STT_TOKEN` env var
   *  when set, otherwise the settings value. Always prefer this over reading
   *  `settings.sttToken` directly. */
  effectiveSttToken(): string {
    return envSttToken() ?? this.settings.sttToken;
  }

  /** Construct + connect the M3 HostAgentClient. Desktop-only (guarded again
   *  here for safety) and opt-in via settings.hostAgentEnabled. Idempotent. */
  async startHostAgentClient(): Promise<void> {
    if (!Platform.isDesktop) return;
    if (this.hostAgentClient) return;
    const { HostAgentClient } = await import('./transport/HostAgentClient');
    const client = new HostAgentClient({
      url: this.settings.ahpServerUrl.trim() || DEFAULT_AHP_SERVER_URL,
      deviceName: this.settings.hostAgentDeviceName || 'Voyager',
      token: this.effectiveAhpToken() || undefined,
      piVersion: this.binaryInfo?.version,
      instanceManager: this.instanceManager,
    });
    this.hostAgentClient = client;
    try {
      await client.start();
    } catch (err) {
      const msg = errorMessage(err);
      new Notice(`AHP host agent connection failed: ${msg}`, 8000);
      try {
        await client.dispose();
      } catch {
        /* non-fatal — the client never connected */
      }
      this.hostAgentClient = null;
    }
  }

  /** Gracefully unregister + disconnect the M3 HostAgentClient (on disable or unload). */
  async stopHostAgentClient(): Promise<void> {
    const client = this.hostAgentClient;
    this.hostAgentClient = null;
    if (!client) return;
    try {
      await client.dispose();
    } catch (err) {
      console.warn('[obsidian-pi] host agent teardown failed', err);
    }
  }

  // ── Terminal view (pi TUI in xterm.js + floating popout prompt editor) ─────────

  /** Write text into the active (or default) pi terminal's PTY as a prompt.
   *  Replaces the old ChatView.setContext() path now that the terminal is the
   *  only pi surface. */
  private async sendToActiveTerminal(text: string): Promise<void> {
    if (!this.requireDesktopFor('Send to pi terminal')) return;
    const active = this.app.workspace.getActiveViewOfType(TerminalView);
    const instanceId = active?.instanceId ?? 'default';
    const client = this.instanceManager.get(instanceId)?.ptyClient ?? null;
    if (!client || client.state !== 'connected') {
      await this.activateTerminalView(instanceId);
      new Notice('pi terminal was not connected — opened it; try sending again.', 4000);
      return;
    }
    client.write(text + '\r');
  }

  /** Instances the UI should render: persisted settings.instances plus the
   *  synthetic remote-AHP instance (if one is active). The ribbon hub, numbered
   *  tab icons, and per-instance commands all iterate this so an AHP session
   *  flows through the full terminal-instance lifecycle. */
  getUiInstances(): PiInstanceConfig[] {
    return [...this.settings.instances, ...this.ahpInstanceConfigs];
  }

  /** Register (or replace) the synthetic AHP instance and refresh every UI
   *  surface that iterates instances (ribbon hub, tab icons, instance command).
   *  Idempotent: re-registering with a new title updates the existing entry. */
  registerAhpInstance(title: string, existingId?: string): string {
    // If existingId is provided (e.g. on reload, the view state already has
    // the instanceId), reuse it instead of creating a new one. Also bump the
    // counter so the next NEW session doesn't collide with a restored one.
    const id = existingId ?? ('ahp-remote-' + (++this.ahpCounter));
    if (existingId) {
      const num = parseInt(existingId.replace('ahp-remote-', ''), 10);
      if (!isNaN(num) && num > this.ahpCounter) this.ahpCounter = num;
    }
    // Don't add a duplicate if this ID is already registered.
    if (this.ahpInstanceConfigs.some((c) => c.id === id)) return id;
    const config = { id, name: title || 'AHP remote', cwd: '', ahp: true };
    this.ahpInstanceConfigs.push(config);
    this.ahpSessionTitle = config.name;
    // Make the runtime PiInstance exist in InstanceManager so its terminalView
    // ref + iconState flow through the hub/tab-icon system.
    const inst = this.instanceManager.getOrCreate(id);
    inst.config = config;
    this.refreshInstanceCommands();
    this.refreshTerminalIcons();
    this.refreshRibbonHub?.();
    this.instanceManager.notifyChanged();
    return id;
  }

  /** Drop the synthetic AHP instance from every UI surface (e.g. on disconnect). */
  unregisterAhpInstance(): void {
    for (const cfg of this.ahpInstanceConfigs) {
      this.instanceManager.dispose(cfg.id);
    }
    this.ahpInstanceConfigs = [];
    this.ahpCounter = 0;
    this.refreshInstanceCommands();
    this.refreshTerminalIcons();
    this.refreshRibbonHub?.();
    this.instanceManager.notifyChanged();
  }

  /** Open (or replace) a TerminalView leaf in AHP mode that renders the active
   *  remote AHP session (plugin.ahpClient) via AhpTerminalAdapter. Any existing
   *  AHP terminal leaf is detached first so the new session opens fresh. When
   *  `terminalUri` is provided the view boots in interactive PTY mode instead
   *  of chat-turn mode. `terminalMode` tells the adapter whether the real PTY is
   *  externally supervised (`external`) or hosted on the server (`server-spawned`
   *  / undefined), which controls whether the viewer requests size changes.
   *  `initialCols`/`initialRows` are the real PTY's actual size from the server
   *  snapshot, applied to the local xterm before data arrives. `initialContent`
   *  is the accumulated scrollback text from the same snapshot, replayed into
   *  the local xterm so relative cursor redraws find the expected screen state. */
  async activateAhpTerminalView(
    terminalUri?: string | null,
    terminalMode?: 'external' | 'server-spawned' | 'none' | null,
    initialCols?: number,
    initialRows?: number,
    initialContent?: string,
    readOnly?: boolean,
    ahpInstanceId?: string,
  ): Promise<void> {
    const { workspace } = this.app;
    // `null` explicitly forces chat mode (no terminal channel) — used by the
    // no-node-pty fallback so a stale ahpTerminalUri from a previous terminal
    // session doesn't leak into the chat-mode view.
    const channel = terminalUri === null ? undefined : (terminalUri ?? this.ahpTerminalUri);
    const mode = terminalMode === null ? undefined : (terminalMode ?? this.ahpTerminalMode);

    // Cache the fresh subscribe snapshot (real PTY size + accumulated
    // scrollback) so BOTH the reuse path and the new-leaf path below hand the
    // view the CURRENT screen state, never a stale one.
    this.ahpInitialCols = initialCols;
    this.ahpInitialRows = initialRows;
    this.ahpInitialContent = initialContent;

    // Reuse the leaf already bound to this session's terminal URI — including
    // deferred (background) leaves — so attaching to the same session never
    // creates a duplicate tab. revealLeaf loads a deferred view, which then
    // boots the adapter for this session. (Mirrors activateTerminalView's
    // instance-leaf reuse.)
    if (channel) {
      const existing = findAhpTerminalLeafForUri(workspace, channel);
      if (existing) {
        // BUG 2 fix: refresh the reused leaf's stored state with the FRESH
        // subscribe snapshot (cols/rows/scrollback) before revealing it. A
        // deferred (background) leaf re-boots from its stored state on reveal;
        // without this update it replays the STALE content from when the leaf
        // was first created — an empty terminal for a session that has prior
        // activity. A live, already-booted view ignores the new initialContent
        // (it never re-boots) and keeps streaming, so the state update is
        // harmless there.
        const vs = existing.getViewState();
        const st = (vs.state ?? {}) as Record<string, unknown>;
        await existing.setViewState({
          ...vs,
          state: {
            ...st,
            ahp: true,
            ahpTerminalUri: channel,
            ...(mode ? { ahpTerminalMode: mode } : {}),
            ...(initialCols !== undefined ? { ahpInitialCols: initialCols } : {}),
            ...(initialRows !== undefined ? { ahpInitialRows: initialRows } : {}),
            ...(initialContent !== undefined ? { ahpInitialContent: initialContent } : {}),
          },
        });
        workspace.revealLeaf(existing);
        return;
      }
    }

    // Don't detach existing AHP terminal leaves — let multiple AHP terminals
    // coexist (each in its own leaf). The leaf-reuse block above handles the
    // same-session case (reuses the leaf). A different session gets a new leaf.
    // Always use a fresh right-sidebar leaf for AHP. Reusing a leaf that
    // already hosts a non-AHP TerminalView would cause Obsidian to call
    // setState() on the existing view instead of constructing a new one. That
    // view already ran onOpen() -> maybeBoot() with this.ahp = false and
    // booted the local PTY (loading node-pty), so flipping it to AHP mode
    // afterwards still leaves the crash banner on platforms without a compatible
    // node-pty build. AHP remote sessions never need the local PTY.
    // Mobile has no usable right sidebar — open in the main editor instead.
    let leaf = Platform.isMobile ? workspace.getLeaf(true) : workspace.getRightLeaf(true);
    if (!leaf) {
      leaf = Platform.isMobile ? workspace.getLeaf(false) : workspace.getRightLeaf(false);
    }
    if (!leaf) {
      new Notice('Could not open terminal view — no sidebar leaf available.', 5000);
      return;
    }
    const state: {
      instanceId: string;
      ahp: boolean;
      ahpTerminalUri?: string;
      ahpTerminalMode?: 'external' | 'server-spawned' | 'none';
      ahpInitialCols?: number;
      ahpInitialRows?: number;
      ahpInitialContent?: string;
      ahpReadOnly?: boolean;
    } = { instanceId: ahpInstanceId ?? 'ahp-remote', ahp: true };
    if (channel) state.ahpTerminalUri = channel;
    if (mode) state.ahpTerminalMode = mode;
    if (initialCols !== undefined) state.ahpInitialCols = initialCols;
    if (initialRows !== undefined) state.ahpInitialRows = initialRows;
    if (initialContent !== undefined) state.ahpInitialContent = initialContent;
    if (readOnly) state.ahpReadOnly = true;
    await leaf.setViewState({
      type: VIEW_TYPE_PI_TERMINAL, active: true,
      state,
    });
    workspace.revealLeaf(leaf);
  }

  /** Activate the terminal view for a specific instance, reusing its bound leaf if one exists. */
  async activateTerminalView(instanceId?: string): Promise<void> {
    const targetId = instanceId ?? 'default';
    // Mobile has no local pi PTY — refuse local-instance opens (belt-and-
    // suspenders on top of the per-instance command/ribbon gating) and point
    // the user at the AHP-remote path.
    const target = this.getUiInstances().find((i) => i.id === targetId);
    if (Platform.isMobile && !target?.ahp) {
      new Notice('obsidian-pi: local pi terminals are only available in the Obsidian desktop app — use a remote AHP session.', 6000);
      return;
    }
    const { workspace } = this.app;

    // Reuse the leaf already bound to this instance — including deferred
    // (background) leaves whose view is still a DeferredView placeholder, so a
    // manual open never creates a duplicate tab for an instance that's already
    // restored-but-unfocused. revealLeaf loads the deferred view, which then
    // boots its PTY and consumes the pending resume path in onOpen.
    const existing = findTerminalLeafForInstance(workspace, targetId);
    if (existing) {
      workspace.revealLeaf(existing);
      const view = existing.view;
      if (view instanceof TerminalView) {
        await view.rebootAhp();
      }
      return;
    }

    // Otherwise open a new leaf in the right sidebar, binding it to the instance.
    // getRightLeaf(false) ("should the existing split be split up?" = no) can
    // return the sidebar's CURRENTLY ACTIVE leaf rather than creating a fresh
    // tab. If that leaf is already showing a DIFFERENT pi terminal instance,
    // reusing it would silently repurpose that instance's live terminal — force
    // a genuinely new leaf instead. (TerminalView.setState()/rebootForInstance()
    // is a defensive backstop for this same scenario, in case Obsidian ever
    // hands back a claimed leaf through some other path.)
    // Mobile has no usable right sidebar — open in the main editor instead.
    let leaf = Platform.isMobile ? workspace.getLeaf(false) : workspace.getRightLeaf(false);
    const reusedId = leaf ? terminalLeafInstanceId(leaf) : undefined;
    if (leaf && reusedId !== undefined && reusedId !== targetId) {
      leaf = Platform.isMobile ? (workspace.getLeaf(true) ?? leaf) : (workspace.getRightLeaf(true) ?? leaf);
    }
    if (!leaf) {
      new Notice('Could not open terminal view — no sidebar leaf available.', 5000);
      return;
    }
    const ahpTarget = !!this.getUiInstances().find((i) => i.id === targetId)?.ahp;
    await leaf.setViewState({
      type: VIEW_TYPE_PI_TERMINAL, active: true,
      state: { instanceId: targetId, ...(ahpTarget ? { ahp: true } : {}) },
    });
    workspace.revealLeaf(leaf);
  }

  /** Register (or refresh) per-instance numbered terminal tab icons. */
  refreshTerminalIcons(): void {
    registerPiTerminalIcons(this.getUiInstances());
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PI_TERMINAL)) {
      if (leaf.view instanceof TerminalView) {
        leaf.view.refreshTabIcon();
      }
    }
  }

  /** Register (or refresh) per-instance "Open pi terminal: <name>" commands. */
  refreshInstanceCommands(): void {
    for (const id of this.registeredInstanceCommandIds) {
      (this.app as any).commands.removeCommand(`${this.manifest.id}:${id}`);
    }
    this.registeredInstanceCommandIds = [];

    for (const instance of this.getUiInstances()) {
      // On mobile, local pi instances have no PTY — only the remote AHP
      // instance gets an "Open terminal" command.
      if (Platform.isMobile && !instance.ahp) continue;
      const id = `open-pi-terminal-${instance.id}`;
      this.addCommand({
        id,
        name: `Open pi terminal: ${instance.name}`,
        callback: () => void this.activateTerminalView(instance.id),
      });
      this.registeredInstanceCommandIds.push(id);
    }

    this.refreshTerminalIcons();
  }

  /** Absolute path to an instance's dedicated session directory (`--session-dir`). */
  getTerminalSessionsDir(instanceId = 'default'): string {
    const instance = this.instanceManager.getOrCreate(instanceId);
    return instanceSessionsDir(this, instance.config);
  }

  /** Connect (spawn) the default instance's PTY client if not already connected. */
  async connectTty(notify = false): Promise<void> {
    return this.instanceManager.connectTty('default', notify);
  }

  // ── Prompt note file-explorer hider ──────────────────────────────────────────

  // Implemented as a single injected CSS rule (`:has()` is supported by
  // Obsidian's Electron) — zero runtime cost, no MutationObserver / full-DOM
  // rescans on every mutation.

  /** Show or hide the scratch prompt note in the file explorer. */
  setPromptNoteHidden(hidden: boolean): void {
    if (hidden) this.applyPromptHiderCss();
    else this.stopPromptNoteHider();
  }

  /** Re-apply hiding after the prompt note path setting changes. */
  refreshPromptNoteHider(): void {
    if (!this.settings.hidePromptNoteInExplorer) return;
    this.applyPromptHiderCss();
  }

  private applyPromptHiderCss(): void {
    const paths = this.settings.instances
      .map((cfg) => instancePromptNotePath(this, cfg))
      .filter(Boolean);
    if (paths.length === 0) { this.stopPromptNoteHider(); return; }
    const selectors = paths.map((notePath) => {
      // Escape for use inside a double-quoted CSS attribute selector string.
      const escaped = notePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `.workspace-leaf-content[data-type="file-explorer"] .tree-item:has(> .tree-item-self[data-path="${escaped}"])`;
    }).join(', ');
    const css = `${selectors} { display: none !important; }`;
    if (!this.promptHiderStyleEl || !this.promptHiderStyleEl.isConnected) {
      this.promptHiderStyleEl?.remove();
      this.promptHiderStyleEl = document.createElement('style');
      this.promptHiderStyleEl.id = 'pi-prompt-note-hider';
      document.head.appendChild(this.promptHiderStyleEl);
    }
    this.promptHiderStyleEl.textContent = css;
  }

  private stopPromptNoteHider(): void {
    this.promptHiderStyleEl?.remove();
    this.promptHiderStyleEl = null;
  }

  /** One-time migration: the default instance's prompt note used to live at the
   *  legacy settings.promptNotePath (e.g. 'pi prompt.md') in the vault root. It now
   *  lives under .obsidian/plugins/<id>/prompts/. Copy the legacy content into the
   *  hidden note (best-effort) so existing content is preserved; the legacy file is
   *  left in place for the user to delete. */
  private async migrateDefaultPromptNote(): Promise<void> {
    const legacy = this.settings.promptNotePath;
    const defaultCfg = this.settings.instances.find((i) => i.id === 'default');
    if (!defaultCfg || !legacy) return;
    const namePath = instancePromptNotePath(this, defaultCfg);
    if (namePath === legacy) return;
    const a = this.app.vault.adapter;
    try {
      if (await a.exists(namePath)) return;            // already present
      if (!(await a.exists(legacy))) return;            // nothing to migrate
      const content = await a.read(legacy);
      await this.hiddenNotes.ensureFile(namePath, content);
    } catch { /* best-effort — a fresh note will be created on demand */ }
  }

  /** Reverse direction of applyRename's note-rename: when the user renames a
   *  'pi prompt — <name>.md' note in the file explorer, update the owning
   *  instance's display name to match (bi-directional sync). */
  private async onPromptNoteRenamed(file: TFile, oldPath: string): Promise<void> {
    for (const cfg of this.settings.instances) {
      if (oldPath !== instancePromptNotePath(this, cfg)) continue;
      const base = file.path.split('/').pop() ?? '';
      const match = base.match(/^pi prompt — (.+)\.md$/);
      if (!match || match[1] === cfg.name) return;
      // Don't steal another instance's name — that would collide note paths.
      if (this.settings.instances.some((i) => i !== cfg && i.name === match[1])) return;
      cfg.name = match[1];
      await this.saveSettings();
      this.refreshInstanceCommands();
      this.refreshTerminalIcons?.();
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PI_TERMINAL)) {
        const view = leaf.view;
        if (view instanceof TerminalView && view.instanceId === cfg.id) view.updateTitle();
      }
      return;
    }
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    // Defensive normalization: data.json is user-editable (and historically
    // accumulated junk from older plugin versions), so every known field is
    // type-checked against DEFAULT_SETTINGS and wrong-typed values fall back
    // to their defaults instead of reaching typed call sites.
    this.settings = normalizeSettings(await this.loadData());
    this.lastInstancesJson = JSON.stringify(this.settings.instances);
  }

  async saveSettings(): Promise<void> {
    // Env-var token overrides: when AHP_SERVER_TOKEN / STT_TOKEN are set the
    // effective token comes from the environment, so never write the secret
    // fields back to data.json (they live in a possibly-synced vault). Strip
    // them from the persisted object only — the in-memory settings keep their
    // values so the settings UI fields stay functional.
    let data: ObsidianPiSettings = this.settings;
    if (ahpTokenOverrideActive() || sttTokenOverrideActive()) {
      // Strip only the overridden secret(s) from the persisted copy — the
      // fields are required on the type, so cast through a mutable record.
      const persist: Record<string, unknown> = { ...this.settings };
      if (ahpTokenOverrideActive()) delete persist.ahpServerToken;
      if (sttTokenOverrideActive()) delete persist.sttToken;
      data = persist as unknown as ObsidianPiSettings;
    }
    await this.saveData(data);
    const nextJson = JSON.stringify(this.settings.instances);
    if (this.lastInstancesJson !== nextJson) {
      this.lastInstancesJson = nextJson;
      this.refreshInstanceCommands();
      this.instanceManager?.notifyChanged();
    }
  }

  // ── Session persistence (Phase 9) ───────────────────────────────────────────

  /**
   * Record the current RPC chat session file path so it can be restored on the
   * next Obsidian restart. Only persists to disk when the value actually changes.
   */
  async recordSessionFile(sessionFile: string | null): Promise<void> {
    if (!this.settings.restoreSessionOnRestart) return;
    if (this.settings.lastSessionFile === sessionFile) return;
    this.settings.lastSessionFile = sessionFile;
    await this.saveSettings();
  }

  /**
   * Record the terminal's active session file (the newest `.jsonl` in the
   * terminal session dir) so it can be resumed on the next Obsidian restart.
   * The PTY has no introspection channel, so we infer the active session as
   * the most recently modified file — pi writes to it as the conversation
   * progresses, so it's always the newest. Only persists on change.
   */
  async recordTerminalSessionFile(): Promise<void> {
    for (const instance of this.instanceManager.all()) {
      await this.instanceManager.recordTerminalSessionFile(instance);
    }
  }

  // ── Binary detection ───────────────────────────────────────────────────────

  async detectBinary(notify = false): Promise<void> {
    const binary = await import('./binary');
    try {
      const info = await binary.detectPiBinary(this.settings.binaryPath || undefined);
      this.binaryInfo = info;
      if (notify) new Notice(`✓ pi ${info.version} detected`);
    } catch (err) {
      this.binaryInfo = null;
      const msg = err instanceof binary.BinaryError ? err.message : `pi binary error: ${String(err)}`;
      new Notice(msg, notify ? 10000 : 5000);
    }

    // Best-effort fd detection for the @-file-reference suggester.
    this.fdPath = await binary.detectFdBinary();
  }

  /**
   * Resolve the base directory for @-file-reference search so it matches the
   * cwd used by the pi subprocess. When `vaultAsCwd` is enabled (default) the
   * vault root is used; otherwise the configured `agentDir` is used, falling
   * back to the vault root as a sensible search root.
   */
  getAgentCwd(): string {
    const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath ?? '';
    if (this.settings.vaultAsCwd && vaultPath) {
      return vaultPath;
    }
    return this.settings.agentDir || vaultPath;
  }

  // ── pi maintenance (update pi / extensions) ─────────────────────────────────

  /**
   * Run pi update commands in a streaming modal. Sandbox-aware: when the active
   * launcher is a `~/.pi-sandboxes/<name>/run.sh`, the self-update runs
   * `npm install @earendil-works/pi-coding-agent@latest` in that sandbox dir
   * (a sandbox pi is a local npm install that `pi update` cannot self-update).
   * Extension updates use `pi update --extensions` via the same launcher.
   */
  async runPiUpdate(self: boolean, extensions: boolean): Promise<void> {
    if (!this.requireDesktopFor('Update pi')) return;
    const [{ preparePiSpawn, getSandboxDir, ensureNodeOnPath }, { PiCommandModal }] = await Promise.all([
      import('./transport/launcher'),
      import('./views/PiCommandModal'),
    ]);
    const startCommand = this.settings.startCommand.trim();
    if (!startCommand && !this.binaryInfo) {
      await this.detectBinary(true);
      if (!this.binaryInfo) return;
    }

    const steps: PiCommandStep[] = [];
    const sandboxDir = startCommand ? getSandboxDir(startCommand) : null;

    if (self) {
      if (sandboxDir) {
        const env: Record<string, string | undefined> = { ...process.env };
        await ensureNodeOnPath(env, this.binaryInfo?.nodeExe);
        steps.push({
          exe: 'npm',
          args: ['install', '@earendil-works/pi-coding-agent@latest'],
          env,
          cwd: sandboxDir,
          label: 'npm install @earendil-works/pi-coding-agent@latest (sandbox)',
        });
      } else {
        try {
          const plan = await preparePiSpawn({
            startCommand: startCommand || undefined,
            binaryInfo: this.binaryInfo ?? undefined,
            args: ['update'],
          });
          steps.push({ ...plan, label: 'pi update' });
        } catch (err) {
          new Notice(errorMessage(err), 8000);
          return;
        }
      }
    }

    if (extensions) {
      try {
        const plan = await preparePiSpawn({
          startCommand: startCommand || undefined,
          binaryInfo: this.binaryInfo ?? undefined,
          args: ['update', '--extensions'],
        });
        steps.push({ ...plan, label: 'pi update --extensions' });
      } catch (err) {
        if (!steps.length) { new Notice(errorMessage(err), 8000); return; }
        console.warn('[obsidian-pi] extension update plan failed:', err);
      }
    }

    if (!steps.length) { new Notice('Nothing to run'); return; }

    const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath ?? '';
    const cwd = this.settings.vaultAsCwd && vaultPath ? vaultPath : undefined;
    for (const s of steps) { if (s.cwd == null) s.cwd = cwd; }

    const title = self && extensions ? 'Updating pi and extensions'
      : self ? 'Updating pi'
      : 'Updating pi extensions';
    const modal = new PiCommandModal(this.app, title);
    modal.open();
    modal.onDone = async (ok) => {
      if (ok && self && !startCommand) await this.detectBinary(false);
    };
    modal.runSteps(steps);
  }

  // ── RPC ────────────────────────────────────────────────────────────────────

  /**
   * Start the macOS menu-bar (tray) coordinator when the user has opted in
   * (settings.menubarEnabled) and we're on macOS. Idempotent: a coordinator
   * already running is stopped first (e.g. when toggled on at runtime). Stopped
   * in onunload.
   */
  async startMenubar(): Promise<void> {
    await this.menubarCoordinator?.stop();
    this.menubarCoordinator = null;
    if (!Platform.isDesktopApp) return;
    if (process.platform !== 'darwin') return;
    if (!this.settings.menubarEnabled) return;
    const { MenubarCoordinator } = await import('./menubar/MenubarCoordinator');
    this.menubarCoordinator = new MenubarCoordinator(this);
    this.menubarCoordinator.start().catch((err) =>
      console.warn('[obsidian-pi] menubar coordinator failed to start', err),
    );
  }

  /**
   * Diagnostic for the menu-bar (tray) feature. Probes how (or whether) the
   * Electron `Tray` is reachable from this renderer and reports the
   * coordinator's runtime state. Prints everything to the console and a
   * short summary to a Notice — run via the command palette
   * ('Debug menu bar (tray)') when the icon doesn't appear.
   */
  async debugMenubar(): Promise<void> {
    const [{ probeElectronMain, probeTrayRegistry }, { menubarSocketPath }] = await Promise.all([
      import('./menubar/MenubarIcon'),
      import('./menubar/MenubarIpc'),
    ]);
    const probe = probeElectronMain();
    const coord = this.menubarCoordinator?.status();
    const registry = probeTrayRegistry(this);
    const summary = {
      platform: process.platform,
      isDesktopApp: Platform.isDesktopApp,
      menubarEnabled: this.settings.menubarEnabled,
      socketPath: menubarSocketPath(),
      electron: { ok: probe.ok, strategy: probe.strategy, keys: probe.keys, attempts: probe.attempts },
      trayRegistry: { loaded: registry.loaded, hasTray: registry.hasTray, path: registry.path },
      coordinator: coord ?? null,
    };
    console.log('[obsidian-pi] menubar debug', summary);
    const ok = probe.ok;
    const line = ok
      ? `Tray via ${probe.strategy}. role=${coord?.role ?? 'stopped'}, reports=${coord?.reports ?? 0}, tray=${coord?.trayPresent ?? false}, registry=${registry.loaded ? 'loaded' : 'missing'}`
      : `Tray UNREACHABLE. attempts: ${probe.attempts.map((a) => `${a.strategy}=${a.result}`).join(', ')}`;
    new Notice(`[obsidian-pi menubar] ${line}\n(full detail in console)`, 12000);
  }

  /**
   * Build an RpcClient from current settings + cached binaryInfo and connect.
   * @param notify  Show a Notice on success / failure when called manually.
   *
   * Concurrent callers share one in-flight connect (rpcConnectPromise) so a
   * reconnect storm never spawns more than one pi subprocess.
   */
  async connectRpc(notify = false): Promise<void> {
    if (this.rpcConnectPromise) return this.rpcConnectPromise;
    this.rpcConnectPromise = this.doConnectRpc(notify).finally(() => {
      this.rpcConnectPromise = null;
    });
    return this.rpcConnectPromise;
  }

  private async doConnectRpc(notify = false): Promise<void> {
    if (!this.requireDesktopFor('Connect pi RPC')) return;
    const { RpcClient } = await import('./transport/RpcClient');
    const path = require('path') as typeof import('path');
    const fs = require('fs') as typeof import('fs');
    const startCommand = this.settings.startCommand.trim();
    if (!startCommand && !this.binaryInfo) {
      await this.detectBinary(true);
      if (!this.binaryInfo) return;
    }

    // Tear down any previous client.
    await this.rpcClient?.dispose();

    const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;

    // Store sessions inside the plugin directory so they're self-contained.
    const sessionsDir = path.join(vaultPath ?? '', this.manifest.dir ?? '.obsidian/plugins/obsidian-pi', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Restore the last active session across Obsidian restarts. We pass pi's
    // `--session <path>` flag so the subprocess loads that session natively on
    // spawn (rather than starting fresh and then switching). Only restore when
    // the saved file still exists on disk.
    const extraArgs = ['--session-dir', sessionsDir];
    if (this.settings.restoreSessionOnRestart && this.settings.lastSessionFile) {
      try {
        if (fs.existsSync(this.settings.lastSessionFile)) {
          extraArgs.push('--session', this.settings.lastSessionFile);
        }
      } catch { /* ignore stat errors — start fresh */ }
    }

    const rpcClient = new RpcClient({
      binaryInfo: this.binaryInfo ?? undefined,
      startCommand: startCommand || undefined,
      cwd:        this.settings.vaultAsCwd && vaultPath ? vaultPath : undefined,
      model:      this.settings.defaultModel || undefined,
      thinkingLevel: this.settings.thinkingLevel !== 'none' ? this.settings.thinkingLevel : undefined,
      agentDir:   this.settings.agentDir || undefined,
      extraArgs,
      env:        this.settings.authStrategy === 'runtime-key' && this.runtimeApiKey
                    ? { ANTHROPIC_API_KEY: this.runtimeApiKey }
                    : undefined,
    });
    this.rpcClient = rpcClient;

    // Surface crash / reconnect state to the user via notices.
    this.rpcClient.onStateChange((state: RpcClientState, err?: Error) => {
      if (state === 'crashed') {
        new Notice(
          `pi agent crashed and could not recover.\n${err?.message ?? ''}`,
          10000,
        );
      } else if (state === 'reconnecting') {
        new Notice('pi agent disconnected — reconnecting…', 3000);
      } else if (state === 'connected' && this.rpcClient?.state === 'connected') {
        // Suppress the initial connect notice; only show on successful recovery.
        if ((this.rpcClient as unknown as { restartAttempt: number }).restartAttempt > 0) {
          new Notice('✓ pi agent reconnected');
        }
      }
    });

    try {
      await this.rpcClient.connect();
      if (notify) new Notice('✓ pi RPC connected');
    } catch (err) {
      const msg = errorMessage(err);
      new Notice(`pi RPC failed to connect: ${msg}`, 8000);
      throw err;
    }
  }

  /** Extra params for the AHP `initialize` handshake (e.g. the shared farm
   *  token when the server requires one). Mobile + desktop both use this so a
   *  token-authenticated server works from the phone. */
  private ahpInitializeParams(): Record<string, unknown> {
    const token = this.effectiveAhpToken().trim();
    return token ? { token } : {};
  }

  /**
   * Unified AHP session picker: connect to the configured server, list existing
   * sessions, and show a picker that includes a synthetic "+ New session" row
   * first. Selecting an existing session opens its interactive terminal
   * directly; selecting "+ New session" reuses the existing newHostedAhpSession()
   * flow.
   */
  async openOrCreateAhpSession(): Promise<void> {
    // Reuse the existing connected AHP client (via ensureAhpCatalogConnection)
    // instead of disposing + recreating — disposing breaks the Farm View's
    // onCatalogChanged subscription (it stays wired to the disposed client), so
    // the Farm View stops live-updating until Obsidian is reloaded.
    const client = await this.ensureAhpCatalogConnection();
    if (!client || client.state !== 'connected') {
      new Notice('AHP connection failed', 4000);
      return;
    }

    // Filter out relay (LiveMirror) sessions — they're local pi session mirrors,
    // not interactive AHP sessions the user can meaningfully open. Keep hosted
    // (provider: pi) + external (host agents like arthur) only.
    let sessions = client.getSessions().filter((s) => s.kind !== 'relay');
    // Merge in archived (past) sessions from the broker's archive dir so the
    // picker can browse past pi sessions (read-only — no live terminal).
    try {
      const archives = await client.listArchives(200);
      sessions = [...sessions, ...archives];
    } catch { /* archive listing optional */ }

    new AhpSessionBrowserModal(
      this.app,
      sessions,
      (session) => void this.openAhpTerminalForSession(session),
      () => void this.newHostedAhpSession(),
      this.settings.hostAgentDeviceName,
    ).open();
  }

  /**
   * Open the Farm view in a new right-sidebar leaf, following the same leaf-open
   * pattern used by TerminalView.
   */
  async activateFarmView(): Promise<void> {
    const { workspace } = this.app;
    for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_FARM_VIEW)) {
      workspace.revealLeaf(leaf);
      return;
    }
    // Mobile has no usable right sidebar — open in the main editor instead.
    const leaf = Platform.isMobile ? workspace.getLeaf(false) : workspace.getRightLeaf(true);
    if (!leaf) {
      new Notice('Could not open Farm view — no sidebar leaf available.', 5000);
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_FARM_VIEW, active: true });
    workspace.revealLeaf(leaf);
  }

  /** Re-render every open Farm view (e.g. after settings change). */
  refreshFarmViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FARM_VIEW)) {
      const view = leaf.view as FarmView;
      if (typeof view.refresh === 'function') {
        view.refresh();
      }
    }
  }

  /**
   * Command entry point for "pi: Dispatch task to swarm worker": pick the pool
   * (defaulting to the first known external host agent) and the task, then
   * dispatch via the AHP relay and show the result.
   */
  async dispatchTaskToWorkerCommand(): Promise<void> {
    const client = await this.ensureAhpCatalogConnection();
    if (!client || client.state !== 'connected') {
      new Notice('AHP client not connected', 4000);
      return;
    }
    const pools = Array.from(
      new Set(
        client
          .getSessions()
          .filter((s) => s.kind === 'external' && s.hostAgentName)
          .map((s) => s.hostAgentName as string),
      ),
    );
    const pool = await TextInputModal.prompt(
      this.app,
      'Dispatch task to swarm worker',
      pools.length > 0 ? `Worker pool (known: ${pools.join(', ')})` : 'Worker pool (host agent device name)',
      pools[0] ?? '',
    );
    if (!pool) return;
    const task = await TextInputModal.prompt(
      this.app,
      'Task for worker',
      `Task for ${pool} (headless pi -p)`,
      '',
    );
    if (!task) return;
    await this.dispatchTaskToWorkerInteractive(pool, task);
  }

  /**
   * Dispatch a headless task to a swarm worker via the AHP relay and show the
   * result. Shared by the Farm View row action and the dispatch command. Shows a
   * persistent "dispatching…" Notice while waiting (up to ~300s).
   */
  async dispatchTaskToWorkerInteractive(pool: string, task: string): Promise<void> {
    const url = this.settings.ahpServerUrl.trim() || DEFAULT_AHP_SERVER_URL;
    const dispatching = new Notice(`⏳ Dispatching to ${pool}…`, 0);
    try {
      const result = await dispatchTaskToWorker({ brokerUrl: url, pool, task });
      showDispatchResult(this.app, result, task, pool);
    } catch (err) {
      const msg = errorMessage(err);
      new Notice(`Dispatch failed: ${msg}`, 8000);
    } finally {
      dispatching.hide();
    }
  }

  /**
   * Ensure the shared AhpClient is connected and subscribed to the root channel
   * so catalogue consumers (e.g. FarmView) receive live session lists. Used by
   * the Farm view so it can share the same client as row actions.
   */
  async ensureAhpCatalogConnection(): Promise<AhpClient | null> {
    const url = this.settings.ahpServerUrl.trim() || DEFAULT_AHP_SERVER_URL;

    let client = this.ahpClient;
    if (client && client.state === 'connected') {
      return client;
    }

    // Serialize concurrent connection attempts so reload-time races (onload
    // scan, restored leaves, onOpen) all await a single handshake instead of
    // disposing each other's in-flight clients.
    if (this.ahpConnectPromise) {
      return this.ahpConnectPromise;
    }

    // Do not dispose a client that is still connecting — another path may be
    // waiting on its handshake. Only tear down an already failed/idle client.
    if (client && client.state !== 'connecting') {
      await client.dispose();
    }

    this.ahpConnectPromise = (async (): Promise<AhpClient | null> => {
      const clientId = `obsidian-pi-${globalThis.crypto.randomUUID()}`;
      client = new AhpClient(clientId);
      this.ahpClient = client;
      client.attachActionMapper();
      try {
        await client.connect(url);
        await client.initialize([AHP_PROTOCOL_VERSION], clientId, this.ahpInitializeParams());
        if (!client.isRootSubscribed) {
          await client.subscribeRoot();
        }
        return client;
      } catch (err) {
        const msg = errorMessage(err);
        if (isAhpError(err, -32005)) {
          // Unsupported protocol version — surface the server's advertised
          // versions so the user knows what to update.
          const data = (err.data ?? {}) as { supportedVersions?: unknown; negotiatedVersion?: unknown };
          const supported = Array.isArray(data.supportedVersions)
            ? data.supportedVersions.map(String).join(', ')
            : 'unknown';
          const negotiated = typeof data.negotiatedVersion === 'string' ? ` (server negotiated '${data.negotiatedVersion}')` : '';
          new Notice(
            `AHP protocol version mismatch${negotiated} — supported versions: ${supported}. Update the pi plugin or the AHP server.`,
            10000,
          );
        } else if (isAhpError(err, -32007)) {
          new Notice(
            'AHP connection failed: authentication rejected by the server — check the server token in the pi plugin settings (error -32007).',
            8000,
          );
        } else {
          new Notice(`AHP connection failed: ${msg}`, 8000);
        }
        await client.dispose();
        this.ahpClient = null;
        this.unregisterAhpInstance();
        return null;
      } finally {
        this.ahpConnectPromise = null;
      }
    })();

    client = await this.ahpConnectPromise;

    // Preserve the original post-connect behavior: if the client is connected
    // but somehow not root-subscribed, subscribe now. With the in-flight promise
    // this branch is normally a no-op, but it keeps the existing contract intact.
    if (client && !client.isRootSubscribed) {
      try {
        await client.subscribeRoot();
      } catch (err) {
        const msg = errorMessage(err);
        new Notice(`AHP root subscribe failed: ${msg}`, 8000);
        return null;
      }
    }

    return client;
  }

  /** Ensure the shared AhpClient is connected and notify restored AHP
   *  TerminalViews that they can retry boot. Returns the connected client or
   *  null if the server is unavailable. */
  async ensureAhpClientReady(): Promise<AhpClient | null> {
    let client = this.ahpClient;
    if (client && client.state === 'connected') {
      this.app.workspace.trigger('ahp-client-ready');
      return client;
    }
    client = await this.ensureAhpCatalogConnection();
    if (client && client.state === 'connected') {
      this.app.workspace.trigger('ahp-client-ready');
    }
    return client;
  }

  /**
   * Open an interactive PTY terminal for a specific AHP session. Shared by the
   * picker and the Farm view so both use the same live-mirror confirmation and
   * terminal-channel subscribe path.
   *
   * Terminal mode is the ONLY attach mode: subscribing to the `ahp-terminal:`
   * channel makes the server spawn (or resume) the pi TUI if it isn't already
   * running, and the subscribe snapshot (real PTY size + accumulated scrollback)
   * is replayed into the view so a late opener sees the terminal exactly as it
   * already is — no blank screen + redraw races. If the subscribe fails with
   * -32000 (no node-pty, or the owning host's local PTY is not running) we
   * report that no interactive terminal is available; there is no chat fallback.
   */
  async openAhpTerminalForSession(session: SessionSummary): Promise<void> {
    // Prefer-local routing (AUDIT FIX SLICE H): a session published by THIS
    // machine's host agent (ext-<device>-<instanceId> for a still-existing
    // local instance) opens directly as a local PTY terminal with session
    // resume — never through the broker self-relay loop, and without the
    // live-mirror warning (nothing remote is being attached).
    if (this.openLocalRelaySessionIfLocal(session)) return;

    const client = this.ahpClient;
    if (!client || client.state !== 'connected') {
      new Notice('AHP client not connected', 4000);
      return;
    }
    // M4 offline UX: an external row whose host agent is offline must NOT open
    // a terminal — the server skips startTerminalStream for offline hosts, so
    // the view would open with stale scrollback and never stream. Checked AFTER
    // the prefer-local routing above: own-device rows open the local PTY
    // directly, which doesn't need the host agent online.
    if (session.kind === 'external' && session.hostOnline === false) {
      new Notice(`Host offline — ${session.hostAgentName ?? 'host'} not connected`, 4000);
      return;
    }
    const ok = await confirmLiveMirrorSession(this.app, session);
    if (!ok) return;

    const displayName = session.title || session.resource;
    const terminalUri = session.resource.replace(/^ahp-session:/, 'ahp-terminal:');
    try {
      // M4 snapshot replay: the terminal subscribe snapshot carries the real
      // PTY size (cols/rows) and the accumulated scrollback (TerminalState.content
      // parts for external relayed terminals, legacy screenText for older
      // servers). Pass them to activateAhpTerminalView so a late opener sees
      // the terminal exactly as it already is — no blank screen + redraw races.
      const snapshot = await client.subscribe(terminalUri);
      const { initialCols, initialRows, initialContent } = extractTerminalSnapshot(snapshot);
      const mode = session.terminalMode === 'external' ? 'external' : 'server-spawned';
      const ahpId = this.registerAhpInstance(displayName);
      this.ahpTerminalUri = terminalUri;
      this.ahpTerminalMode = mode;
      await this.activateAhpTerminalView(
        terminalUri,
        mode,
        initialCols,
        initialRows,
        initialContent,
        undefined,
        ahpId,
      );
      new Notice(`✓ AHP interactive terminal: ${terminalUri}`, 4000);
    } catch (err) {
      const msg = errorMessage(err);
      if (isAhpError(err, -32000)) {
        // A -32000 from an external session means the owning host's local PTY
        // is not running (M3 tee error-ack), not a server-side node-pty gap.
        if (session.kind === 'external') {
          new Notice(`AHP host terminal not running on ${session.hostAgentName ?? 'host'}`, 6000);
          return;
        }
        // The server has no node-pty — no interactive terminal is available.
        // Terminal is the only attach mode: do NOT fall back to chat.
        new Notice('AHP: no interactive terminal on this server', 6000);
        return;
      }
      if (isAhpError(err, -32002)) {
        // Session not found on the server — the catalogue entry is stale.
        // Quiet best-effort cleanup: forget it locally and dispose it
        // server-side (no-op when it is already gone). No noisy notice —
        // the picker refreshes via its catalogue subscription.
        this.unregisterAhpInstance();
        try {
          await client.disposeSession(session.resource);
        } catch {
          /* best-effort — the session may already be gone or the ws is down */
        }
        return;
      }
      if (isAhpError(err, -32007)) {
        new Notice(
          'AHP terminal rejected: authentication failed — check the server token in the pi plugin settings',
          8000,
        );
        return;
      }
      new Notice(`AHP terminal subscribe failed: ${msg}`, 8000);
      return;
    }
  }

  /**
   * Open a local instance's terminal, resuming the session named by
   * `sessionTitle` when possible (desktop-only). Shared by the Farm view's
   * open path and openLocalRelaySessionIfLocal so every surface uses the same
   * local-open + resume sequence.
   */
  async openLocalInstanceWithResume(instanceId: string, sessionTitle?: string): Promise<void> {
    if (!Platform.isDesktop) {
      new Notice('Local terminal only available on desktop', 4000);
      return;
    }
    const manager = this.instanceManager;
    if (!manager) {
      new Notice('Instance manager not available', 4000);
      return;
    }
    const instance = manager.get(instanceId);
    if (!instance) {
      new Notice(`Local instance ${instanceId} not found`, 4000);
      return;
    }
    const resumePath = await manager.resolveLocalSessionResumePath(instanceId, sessionTitle);
    if (resumePath && instance.ptyClient?.state === 'connected') {
      await manager.restartTerminalSession(instanceId, resumePath);
    } else if (resumePath) {
      instance.pendingResumeSessionPath = resumePath;
    }
    await this.activateTerminalView(instanceId);
  }

  /**
   * Prefer-local routing (AUDIT FIX SLICE H): when `session` is an external/
   * relay row published by THIS device's host agent (resource
   * `ahp-session:/ext-<hostAgentDeviceName>-<instanceId>`) and the instance
   * still exists locally, open it as a local terminal with session resume
   * instead of attaching through the broker. Returns true when the session was
   * routed locally (caller must NOT continue with the remote AHP attach);
   * false → caller continues with the normal AHP path. Own-device rows whose
   * instance no longer resolves (renamed/deleted) fall through to AHP attach.
   */
  openLocalRelaySessionIfLocal(session: SessionSummary): boolean {
    if (!Platform.isDesktop) return false;
    const match = matchLocalRelaySession(session, this.settings.hostAgentDeviceName);
    if (!match) return false;
    if (!this.instanceManager?.get(match.instanceId)) return false;
    void this.openLocalInstanceWithResume(match.instanceId, session.title);
    return true;
  }

  /**
   * Open a read-only terminal mirror for a subagent child chat by replacing the
   * `ahp-chat:` scheme with `ahp-terminal:` and subscribing to that channel. The
   * server replays the subagent's chat history as terminal/data and then streams
   * live chat actions as terminal text; terminal/input is ignored. Reuses the
   * same TerminalView + AhpTerminalAdapter PTY path but passes `readOnly: true`
   * so the view disables keystroke forwarding and shows a read-only indicator.
   */
  async openAhpTerminalForChat(chatUri: string): Promise<void> {
    const client = await this.ensureAhpCatalogConnection();
    if (!client || client.state !== 'connected') {
      new Notice('AHP client not connected', 4000);
      return;
    }

    const terminalUri = deriveAhpTerminalUriFromChat(chatUri);
    let initialCols: number | undefined;
    let initialRows: number | undefined;
    let initialContent: string | undefined;
    try {
      // Same snapshot replay as the session attach path: the terminal subscribe
      // snapshot carries the real PTY size + accumulated scrollback, which the
      // view replays into xterm on boot (and which the leaf-reuse path needs to
      // refresh a deferred leaf's stored state).
      const snapshot = await client.subscribe(terminalUri);
      ({ initialCols, initialRows, initialContent } = extractTerminalSnapshot(snapshot));
    } catch (err) {
      const msg = errorMessage(err);
      new Notice(`AHP terminal subscribe failed: ${msg}`, 8000);
      return;
    }

    // Bind the leaf to the RETURNED synthetic instance id ('ahp-remote-N') —
    // passing it through the leaf state is what makes the tab icon, per-instance
    // commands, and ribbon hub resolve THIS runtime instance instead of the
    // hardcoded 'ahp-remote' default (AUDIT §3 finding 12). The restore path
    // picks the same id back up: TerminalView.bootAhpTerminal re-registers via
    // registerAhpInstance(getDisplayText(), state.instanceId).
    const ahpId = this.registerAhpInstance(terminalUri);
    this.ahpTerminalUri = terminalUri;
    this.ahpTerminalMode = 'server-spawned';
    await this.activateAhpTerminalView(terminalUri, 'server-spawned', initialCols, initialRows, initialContent, true, ahpId);
    new Notice(`✓ AHP read-only subagent terminal: ${terminalUri}`, 4000);
  }

  /**
   * Create a new hosted `pi` session directly on the remote AHP server. Prompts
   * for a session name and a server-side absolute working directory, sends
   * `createSession` with `provider: 'pi'` and a `file://` workingDirectory URI,
   * eagerly subscribes to the terminal channel so the server spawns a persistent
   * multi-client PTY, and opens the AHP terminal view in interactive terminal
   * mode.
   */
  async newHostedAhpSession(): Promise<void> {
    const vaultName = this.app.vault.getName()
      .replace(/[^\w-]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
    const defaultName = vaultName ? `pi-${vaultName}` : `pi-${Date.now()}`;

    const name = await TextInputModal.prompt(
      this.app,
      'New hosted pi session',
      'Session name (e.g. pi-myproj)',
      defaultName,
    );
    if (!name) return;

    const rawPath = await TextInputModal.prompt(
      this.app,
      'Server-side working directory',
      'Absolute path on the AHP server (must exist there), e.g. /app or /home/ulysse/RnD/AHP',
      '',
    );
    if (rawPath === null) return;

    let workingDirectory: string;
    if (/^file:\/\//i.test(rawPath)) {
      workingDirectory = rawPath;
    } else if (rawPath.trim()) {
      workingDirectory = `file://${encodeURI(rawPath.trim())}`;
    } else {
      workingDirectory = '';
    }

    const sessionUri = `ahp-session:/${name}`;

    // Reuse the existing connected AHP client (don't dispose+recreate — that
    // breaks the Farm View's onCatalogChanged subscription, same as the picker).
    const client = await this.ensureAhpCatalogConnection();
    if (!client || client.state !== 'connected') {
      new Notice('AHP connection failed', 4000);
      return;
    }

    // -32003 (session already exists) is tolerated: e.g. a previous create
    // left the session behind server-side — it is attachable, so proceed.
    try {
      await client.createSession(sessionUri, { provider: 'pi', workingDirectory, title: name });
    } catch (err) {
      if (!isAhpError(err, -32003)) throw err;
    }

    try {
      await createHostedAhpSession(this, sessionUri, name, client);

      new Notice(`✓ AHP hosted session created: ${sessionUri}`, 4000);
    } catch (err) {
      const msg = errorMessage(err);
      // If createSession succeeded but a later step failed (e.g. the terminal
      // subscribe), the session is orphaned on the server — clean it up so the
      // picker doesn't keep listing a half-created session.
      try {
        await client.disposeSession(sessionUri);
      } catch {
        /* best-effort — the connection may already be gone */
      }
      if (isAhpError(err, -32000)) {
        // -32000 from the create flow means the server could not start the
        // interactive terminal: node-pty not installed on the server, or the
        // working directory does not exist there (spawn ENOENT). The session
        // was created but has no usable terminal — report the actionable
        // cause instead of the raw JSON-RPC error.
        new Notice('The AHP server could not start the interactive terminal (error -32000). Common causes: node-pty not installed on the server, or the working directory does not exist on the server. Fix the server, then retry.', 8000);
      } else {
        new Notice(`AHP hosted session failed: ${msg}`, 8000);
      }
      // Do NOT dispose the shared client here: it is process-wide and
      // FarmView/terminal subscriptions point at it — disposing it on a failed
      // create silently killed the catalogue (audit §1.1 #4). The failed
      // session was already cleaned up server-side via disposeSession above.
      this.unregisterAhpInstance();
    }
  }

  // ── Headless operations (Phase 5) ────────────────────────────────────────────

  /** Build JsonRunnerOptions from current plugin settings. */
  private buildJsonRunnerOptions(): JsonRunnerOptions | null {
    if (!this.binaryInfo) return null;
    const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
    return {
      binaryInfo: this.binaryInfo,
      cwd:        this.settings.vaultAsCwd && vaultPath ? vaultPath : undefined,
      model:      this.settings.defaultModel || undefined,
      thinkingLevel: this.settings.thinkingLevel !== 'none' ? this.settings.thinkingLevel : undefined,
      agentDir:   this.settings.agentDir || undefined,
      env:        this.settings.authStrategy === 'runtime-key' && this.runtimeApiKey
                    ? { ANTHROPIC_API_KEY: this.runtimeApiKey }
                    : undefined,
      noSession:  true,
    };
  }

  /** Parse a `pi` codeblock source — supports plain text or JSON {prompt, model, includeNote}. */
  private parseCodeblockSource(source: string): { prompt: string; model?: string; includeNote?: boolean } {
    const trimmed = source.trim();
    if (!trimmed) return { prompt: '' };
    try {
      const json = JSON.parse(trimmed);
      if (json && typeof json.prompt === 'string') {
        return {
          prompt: json.prompt,
          model: typeof json.model === 'string' ? json.model : undefined,
          includeNote: json.includeNote === true,
        };
      }
    } catch { /* not JSON — treat as plain text */ }
    return { prompt: trimmed };
  }

  /** Run a headless pi prompt and show the result in a modal. */
  private async runHeadless(source: string, sourceFile: TFile | null, lineStart?: number): Promise<void> {
    const { prompt, model, includeNote } = this.parseCodeblockSource(source);
    if (!prompt) {
      new Notice('Empty pi codeblock', 3000);
      return;
    }

    // Optionally prepend the source note content as context.
    let fullPrompt = prompt;
    if (includeNote && sourceFile) {
      const content = await this.app.vault.read(sourceFile);
      const resolved = this.vaultContext?.replaceWikilinks(content) ?? content;
      fullPrompt = `Here is the content of this note "${sourceFile.basename}":\n\n---\n${resolved}\n---\n\n${prompt}`;
    }

    await this.runResolvedHeadless(fullPrompt, source, sourceFile, lineStart, model);
  }

  /**
   * Run an already-assembled prompt headlessly (wikilinks resolved here; no
   * codeblock JSON parsing). Used by runHeadless() after parsing and directly
   * by runFrontmatterTrigger() — the latter must NOT round-trip through
   * parseCodeblockSource, which would mis-parse note content that happens to
   * be valid JSON.
   */
  private async runResolvedHeadless(
    fullPrompt: string,
    source: string,
    sourceFile: TFile | null,
    lineStart?: number,
    model?: string,
  ): Promise<void> {
    if (!this.requireDesktopFor('Run pi headlessly')) return;
    // Resolve wikilinks in the full prompt.
    const resolvedPrompt = this.vaultContext?.replaceWikilinks(fullPrompt) ?? fullPrompt;

    const opts = this.buildJsonRunnerOptions();
    if (!opts) {
      new Notice('pi binary not detected. Check plugin settings.', 5000);
      return;
    }
    if (model) opts.model = model;

    // Rerun callback — re-runs the same prompt with a variation seed to
    // avoid an identical response while keeping the same intent.
    const rerun = async () => {
      const seed = Math.random().toString(36).slice(2, 10);
      const variation = `\n\n---\n(Regenerate with a fresh perspective. Provide a different but equally accurate response. Seed: ${seed})`;
      await this.runHeadlessWithPrompt(resolvedPrompt + variation, source, sourceFile, lineStart, model);
    };

    await this.runHeadlessWithPrompt(resolvedPrompt, source, sourceFile, lineStart, model, rerun);
  }

  /** Internal: run a resolved prompt and show the result modal. */
  private async runHeadlessWithPrompt(
    resolvedPrompt: string,
    source: string,
    sourceFile: TFile | null,
    lineStart?: number,
    model?: string,
    rerun?: () => Promise<void>,
  ): Promise<void> {
    const opts = this.buildJsonRunnerOptions();
    if (!opts) {
      new Notice('pi binary not detected. Check plugin settings.', 5000);
      return;
    }
    if (model) opts.model = model;

    const [{ JsonRunner }, { HeadlessResultModal }] = await Promise.all([
      import('./transport/JsonRunner'),
      import('./views/HeadlessResultModal'),
    ]);

    const runningNotice = new Notice('⏳ Running pi…', 0);
    try {
      const runner = new JsonRunner(opts);
      const result = await runner.run(resolvedPrompt);
      runningNotice.hide();
      new HeadlessResultModal(
        this.app, result, this.vaultContext!, sourceFile, lineStart,
        resolvedPrompt, rerun,
      ).open();
    } catch (err) {
      runningNotice.hide();
      new Notice(`pi run failed: ${errorMessage(err)}`, 8000);
    }
  }

  /** Run the frontmatter `pi-trigger` field from the active note — always includes note content. */
  private async runFrontmatterTrigger(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('No active note', 3000);
      return;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    const trigger = cache?.frontmatter?.['pi-trigger'];
    if (!trigger || typeof trigger !== 'string') {
      new Notice('No `pi-trigger` field in frontmatter', 3000);
      return;
    }
    // Always include the note content so pi has context.
    const content = await this.app.vault.read(file);
    const resolved = this.vaultContext?.replaceWikilinks(content) ?? content;
    const fullPrompt = `Here is the content of this note "${file.basename}":\n\n---\n${resolved}\n---\n\n${trigger}`;
    // Bypass codeblock parsing — this is a final prompt, not codeblock source.
    await this.runResolvedHeadless(fullPrompt, fullPrompt, file);
  }

  /** Run the first `pi` codeblock found in the active note. */
  private async runFirstCodeblock(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('No active note', 3000);
      return;
    }
    const content = await this.app.vault.read(file);
    const lines = content.split('\n');

    // Find the first ```pi codeblock.
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '```pi') {
        const blockLines: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '```') break;
          blockLines.push(lines[j]);
        }
        await this.runHeadless(blockLines.join('\n'), file, i);
        return;
      }
    }
    new Notice('No `pi` codeblock found in this note', 3000);
  }

  /** Open a modal to type a one-shot prompt and run it — with full autocomplete. */
  private runOneShotModal(): void {
    const modal = new Modal(this.app);
    modal.titleEl.setText('Run pi one-shot');
    modal.contentEl.createEl('p', { text: 'Type a prompt — pi will run it headlessly and show the result. Use [[ for wikilinks or / for commands.' });
    const textarea = modal.contentEl.createEl('textarea');
    textarea.style.cssText = 'width: 100%; min-height: 100px; resize: vertical; padding: 8px; border-radius: 6px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); color: var(--text-normal); font-family: var(--font-monospace);';
    textarea.placeholder = 'e.g. Summarize [[ROADMAP]] and suggest improvements';

    // Attach the same autocomplete suggesters as the chat input.
    const wikilinkSuggester = new WikilinkSuggester(textarea, this.app);
    const commandSuggester = new CommandSuggester(textarea, () => this.rpcClient);
    const fileAtSuggester = new FileAtSuggester(
      new TextareaEditorAdapter(textarea),
      { baseDir: this.getAgentCwd(), fdPath: this.fdPath },
    );

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        // Don't run if a suggester popup is active — it handles Enter.
        if (wikilinkSuggester.isActive || commandSuggester.isActive || fileAtSuggester.isActive) {
          return;
        }
        e.preventDefault();
        const prompt = textarea.value.trim();
        if (!prompt) return;
        modal.close();
        const file = this.app.workspace.getActiveFile();
        this.runHeadless(prompt, file);
      }
    });

    // Clean up suggesters when the modal closes.
    modal.onClose = () => {
      wikilinkSuggester.destroy();
      commandSuggester.destroy();
      fileAtSuggester.destroy();
    };

    modal.open();
    setTimeout(() => textarea.focus(), 50);
  }
}

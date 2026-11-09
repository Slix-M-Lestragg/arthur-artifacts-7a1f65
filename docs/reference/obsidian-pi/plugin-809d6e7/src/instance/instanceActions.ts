import { App, FuzzySuggestModal, Modal, Notice, Platform, Setting } from 'obsidian';
import type ObsidianPiPlugin from '../main';
import type { PiInstanceConfig } from '../types';
import { TextInputModal } from '../views/TextInputModal';
import { InstancePickerModal } from '../views/InstancePickerModal';
import { TerminalView, VIEW_TYPE_PI_TERMINAL } from '../views/TerminalView';
import { instancePromptNotePath } from './InstancePaths';

/** Best-effort absolute path to the vault root. */
export function getVaultPath(plugin: ObsidianPiPlugin): string {
  return (plugin.app.vault.adapter as { basePath?: string }).basePath ?? '';
}

/**
 * Directory picker used when choosing an instance working directory.
 * Tries the native Electron folder dialog first, then falls back to a fuzzy
 * picker of directories directly under the vault root.
 */
export async function browseDirectory(
  plugin: ObsidianPiPlugin,
  initial: string,
): Promise<string | null> {
  if (!Platform.isDesktop) return null;
  const vaultPath = getVaultPath(plugin);
  const defaultPath = initial || vaultPath;

  try {
    const electron = window.require('electron');
    const currentWindow = electron.remote?.getCurrentWindow?.() ?? undefined;
    const result = await electron.remote.dialog.showOpenDialog(currentWindow, {
      properties: ['openDirectory'],
      defaultPath,
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  } catch {
    /* fall through to vault-root browser */
  }

  const picked = await new VaultDirectoryPickerModal(plugin.app, vaultPath).openAndAwait();
  return picked;
}

/**
 * Interactively add a new terminal instance.
 * Prompts for a name, then a working directory, appends the config, saves,
 * refreshes commands/icons, and returns the created instance (or null if
 * the name prompt is cancelled).
 */
export async function addInstanceInteractive(
  plugin: ObsidianPiPlugin,
): Promise<PiInstanceConfig | null> {
  const nextNum = plugin.settings.instances.length + 1;
  const defaultName = `Instance ${nextNum}`;
  const name = await TextInputModal.prompt(
    plugin.app,
    'Name for new instance',
    defaultName,
    defaultName,
  );
  if (!name) return null;

  const vaultPath = getVaultPath(plugin);
  const cwd = (await browseDirectory(plugin, vaultPath)) ?? vaultPath;
  const instance: PiInstanceConfig = {
    id: `inst-${Date.now()}`,
    name,
    cwd,
  };
  plugin.settings.instances.push(instance);
  await plugin.saveSettings();

  // Ensure the new instance has a PromptPopout and its dedicated prompt note
  // immediately (no reload needed), and refresh the note-hider CSS so the
  // new note respects the user's hide-prompt-note setting.
  plugin.instanceManager.ensurePromptPopout(instance.id);
  await plugin.instanceManager.ensureInstancePromptNote(instance.id);
  plugin.refreshPromptNoteHider();
  plugin.refreshRibbonHub?.();

  return instance;
}

/**
 * Interactively remove a non-default terminal instance.
 * Shows a picker, guards against removing an instance with an open terminal
 * view, confirms, then disposes runtime state, removes the config, saves,
 * and refreshes commands/icons.
 */
/**
 * Remove a specific (non-default) terminal instance directly — no picker.
 * Closes the instance's open terminal leaf AND any docked/floating/embedded
 * prompt editor first, then tears down the PTY, drops the config, and persists.
 * Used by the ribbon hub's per-instance right-click "Remove" action (which
 * already knows which instance was right-clicked) and by removeInstanceInteractive().
 */
export async function removeInstanceDirect(
  plugin: ObsidianPiPlugin,
  instanceId: string,
): Promise<boolean> {
  if (instanceId === 'default') {
    new Notice('The default instance cannot be removed.', 4000);
    return false;
  }
  const cfg = plugin.settings.instances.find((i) => i.id === instanceId);
  if (!cfg) return false;

  const confirmed = await confirmAction(
    plugin.app,
    'Remove instance?',
    `Remove "${cfg.name}"? Its terminal and prompt editor will be closed. Terminal session files are kept on disk.`,
  );
  if (!confirmed) return false;

  // Close the instance's terminal leaf (detaching it runs TerminalView.onClose,
  // which unmounts the embedded prompt panel and drops the per-instance view
  // ref) and any standalone popout/docked prompt editor.
  await closeInstanceTerminalLeaf(plugin, instanceId);
  plugin.instanceManager.getPromptPopout(instanceId)?.close();

  // Tear down the PTY + runtime state (also re-closes the prompt popout — no-op).
  plugin.instanceManager.dispose(instanceId);

  const index = plugin.settings.instances.findIndex((i) => i.id === instanceId);
  if (index >= 0) plugin.settings.instances.splice(index, 1);
  await plugin.saveSettings();
  plugin.refreshPromptNoteHider();
  plugin.refreshRibbonHub?.();
  return true;
}

/**
 * Interactively remove a non-default terminal instance via a picker modal.
 * Delegates to removeInstanceDirect() once an instance is chosen.
 */
export async function removeInstanceInteractive(
  plugin: ObsidianPiPlugin,
): Promise<boolean> {
  const removable = plugin.settings.instances.filter((i) => i.id !== 'default');
  if (removable.length === 0) {
    new Notice('No removable instances. The default instance cannot be removed.', 4000);
    return false;
  }
  const chosenId = await new Promise<string | null>((resolve) => {
    new InstancePickerModal(
      plugin.app,
      plugin,
      (id) => resolve(id),
      'Remove instance…',
      (cfg) => cfg.id !== 'default',
    ).open();
  });
  if (!chosenId) return false;
  return removeInstanceDirect(plugin, chosenId);
}

/** Detach the terminal view leaf bound to an instance (if any), closing it. */
async function closeInstanceTerminalLeaf(plugin: ObsidianPiPlugin, instanceId: string): Promise<void> {
  for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PI_TERMINAL)) {
    const vs = leaf.getViewState();
    const id = (vs?.state as { instanceId?: string } | undefined)?.instanceId;
    if (id === instanceId) {
      try { await leaf.detach(); } catch { /* ignore */ }
    }
  }
}

/**
 * Interactively rename an instance.
 * Shows a picker, prompts for a new name, updates the config, saves, refreshes
 * command labels and tab icons, and updates any open terminal leaf titles.
 */
async function applyRename(
  plugin: ObsidianPiPlugin,
  instanceId: string,
  newName: string,
): Promise<boolean> {
  const cfg = plugin.settings.instances.find((i) => i.id === instanceId);
  if (!cfg) return false;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === cfg.name) return false;
  // Prevent duplicate instance names — they'd collide on the name-based prompt
  // note path (two instances sharing one note file).
  if (plugin.settings.instances.some((i) => i.id !== instanceId && i.name === trimmed)) {
    new Notice(`An instance named “${trimmed}” already exists`, 3000);
    return false;
  }

  const oldName = cfg.name;
  cfg.name = trimmed;
  await plugin.saveSettings();
  plugin.refreshInstanceCommands();
  plugin.refreshTerminalIcons?.();
  plugin.refreshRibbonHub?.();

  // Keep the dedicated prompt note in sync with the instance name: rename the
  // hidden note file on disk (preserving content) to the new name-based path.
  // HiddenNoteRegistry mutates the existing synthetic TFile in place so any open
  // MarkdownView stays bound to it across the rename.
  const oldPath = instancePromptNotePath(plugin, { ...cfg, name: oldName });
  const newPath = instancePromptNotePath(plugin, cfg); // cfg.name is now trimmed
  if (oldPath !== newPath) {
    try { await plugin.hiddenNotes.renameFile(oldPath, newPath); }
    catch { /* best-effort */ }
    plugin.refreshPromptNoteHider();
  }

  for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PI_TERMINAL)) {
    const view = leaf.view;
    if (view instanceof TerminalView && view.instanceId === instanceId) {
      view.updateTitle();
    }
  }
  return true;
}

/** Rename via command palette / ribbon — picks the instance first. */
export async function renameInstanceInteractive(
  plugin: ObsidianPiPlugin,
): Promise<boolean> {
  const chosenId = await new Promise<string | null>((resolve) => {
    new InstancePickerModal(
      plugin.app,
      plugin,
      (id) => resolve(id),
      'Rename instance…',
    ).open();
  });

  if (!chosenId) return false;

  const cfg = plugin.settings.instances.find((i) => i.id === chosenId);
  if (!cfg) return false;

  const newName = await TextInputModal.prompt(
    plugin.app,
    'Rename instance',
    cfg.name,
    cfg.name,
  );
  if (!newName) return false;
  return applyRename(plugin, chosenId, newName);
}

/** Rename a specific instance directly (no picker) — used by the in-view title click. */
export async function renameInstanceDirect(
  plugin: ObsidianPiPlugin,
  instanceId: string,
): Promise<boolean> {
  const cfg = plugin.settings.instances.find((i) => i.id === instanceId);
  if (!cfg) return false;
  const newName = await TextInputModal.prompt(
    plugin.app,
    'Rename instance',
    cfg.name,
    cfg.name,
  );
  if (!newName) return false;
  return applyRename(plugin, instanceId, newName);
}

/** Change a specific instance's working directory (no picker) — opens the folder
 *  browser seeded with the current cwd, then gracefully restarts pi in the
 *  new directory: sends `/quit` so pi exits cleanly (and saves its session),
 *  waits briefly for the exit to land, then respawns the PTY — which reads the
 *  updated config.cwd — so pi starts again already cd'd into the selected path. */
export async function changeInstanceDirectoryInteractive(
  plugin: ObsidianPiPlugin,
  instanceId: string,
): Promise<boolean> {
  const cfg = plugin.settings.instances.find((i) => i.id === instanceId);
  if (!cfg) return false;
  const picked = await browseDirectory(plugin, cfg.cwd);
  if (!picked || picked === cfg.cwd) return false;
  cfg.cwd = picked;
  await plugin.saveSettings();

  // Gracefully quit pi so it can flush/save its session, then respawn the PTY
  // in the new cwd. /quit is a recognized clean-exit signal, so it does NOT
  // trigger the crash-restart loop (which would race to relaunch with the old
  // cwd before we get to restart).
  const instance = plugin.instanceManager.get(instanceId);
  const client = instance?.ptyClient;
  if (client && client.state === 'connected') {
    try { client.write('/quit\r'); } catch { /* ignore — dispose will handle it */ }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  await plugin.instanceManager.restartTerminalSession(instanceId);

  for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PI_TERMINAL)) {
    const view = leaf.view;
    if (view instanceof TerminalView && view.instanceId === instanceId) {
      view.updateTitle();
    }
  }
  new Notice(`pi restarted in ${picked}`, 3000);
  return true;
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
    if (this.message) contentEl.createEl('p', { text: this.message });

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText('Confirm')
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
export function confirmAction(app: App, title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new ConfirmModal(app, title, message, (confirmed) => {
      resolve(confirmed === true);
    });
    modal.open();
  });
}

/**
 * Fallback directory picker: fuzzy-search directories directly under a base path.
 * Returns the absolute path of the selected directory.
 */
class VaultDirectoryPickerModal extends FuzzySuggestModal<string> {
  private resolvePromise: ((value: string | null) => void) | null = null;

  constructor(app: App, private readonly basePath: string) {
    super(app);
    this.setPlaceholder('Pick a directory under the vault root…');
    this.setInstructions([
      { command: '↩', purpose: 'select directory' },
      { command: 'esc', purpose: 'cancel' },
    ]);
  }

  openAndAwait(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  getItems(): string[] {
    try {
      const fs = window.require('fs') as typeof import('fs');
      const path = window.require('path') as typeof import('path');
      const entries = fs.readdirSync(this.basePath, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => path.join(this.basePath, e.name));
    } catch {
      return [];
    }
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.resolvePromise?.(item);
    this.resolvePromise = null;
  }

  onClose(): void {
    super.onClose();
    this.resolvePromise?.(null);
    this.resolvePromise = null;
  }
}

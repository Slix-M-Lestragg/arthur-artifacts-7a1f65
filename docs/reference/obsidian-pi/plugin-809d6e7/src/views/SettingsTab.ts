import { App, Modal, Notice, Platform, PluginSettingTab, Setting, setIcon } from 'obsidian';
import type ObsidianPiPlugin from '../main';
import type { BinaryError } from '../binary';
import type { ObsidianPiSettings, PiInstanceConfig } from '../types';
import { DEFAULT_AHP_SERVER_URL } from '../constants';
import { instancePromptNotePath } from '../instance/InstancePaths';
import {
  addInstanceInteractive,
  browseDirectory,
  removeInstanceInteractive,
} from '../instance/instanceActions';
import { ProviderPanel } from './ProviderPanel';
import { SettingsBridgeModal } from './SettingsBridgeModal';
import { ModelBrowserModal } from './ModelBrowserModal';
import {
  MENUBAR_ICON_STYLES,
  MENUBAR_ICON_STYLE_LABELS,
  renderObsidianIconDataUrl,
  resolveAccentColor,
  type MenubarIconStyle,
} from '../menubar/MenubarIconArt';

/** Tab identifiers for the multi-tab settings UI. */
type PiSettingsTab = 'general' | 'terminal' | 'auth' | 'farm' | 'prompt-voice';

interface TabDef {
  id: PiSettingsTab;
  label: string;
  icon: string;
}

const SETTINGS_TABS: readonly TabDef[] = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'auth', label: 'Auth & Providers', icon: 'key-round' },
  { id: 'farm', label: 'Farm View', icon: 'table' },
  { id: 'prompt-voice', label: 'Prompt & Voice', icon: 'mic' },
] as const;

export class ObsidianPiSettingsTab extends PluginSettingTab {
  private readonly plugin: ObsidianPiPlugin;

  /**
   * Currently active settings tab.
   * Persisted as an instance field so it survives settings open/close within
   * a session (the PluginSettingTab instance is created once and reused).
   * Resets to 'general' when Obsidian restarts (plugin recreated).
   */
  private activeTab: PiSettingsTab = 'general';

  /** Live-refreshes the icon-style preview thumbnails while Settings is open,
   *  so an accent-color change made in Appearance settings is reflected without
   *  reopening this tab. Cleared in {@link hide}. */
  private iconPreviewRefreshTimer: number | null = null;

  constructor(app: App, plugin: ObsidianPiPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    if (this.iconPreviewRefreshTimer !== null) {
      window.clearInterval(this.iconPreviewRefreshTimer);
      this.iconPreviewRefreshTimer = null;
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('pi-settings-container');

    containerEl.createEl('h2', { text: 'obsidian-pi' });

    // ── Tab bar (sticky, icon + label) ───────────────────────────────────────
    const tabContainer = containerEl.createDiv({ cls: 'pi-settings-tabs' });
    for (const tab of SETTINGS_TABS) {
      const tabBtn = tabContainer.createEl('button', { cls: 'pi-settings-tab' });
      setIcon(tabBtn, tab.icon);
      tabBtn.createSpan({ text: tab.label });
      if (this.activeTab === tab.id) tabBtn.addClass('pi-settings-tab-active');
      tabBtn.onclick = () => {
        if (this.activeTab === tab.id) return;
        this.activeTab = tab.id;
        this.display();
      };
    }

    // ── Tab content ──────────────────────────────────────────────────────────
    const contentEl = containerEl.createDiv({ cls: 'pi-settings-tab-content' });
    switch (this.activeTab) {
      case 'general':
        this.renderGeneralTab(contentEl);
        break;
      case 'terminal':
        this.renderTerminalTab(contentEl);
        break;
      case 'auth':
        this.renderAuthTab(contentEl);
        break;
      case 'farm':
        this.renderFarmTab(contentEl);
        break;
      case 'prompt-voice':
        this.renderPromptVoiceTab(contentEl);
        break;
    }
  }

  // ── General tab: pi Binary + Agent ───────────────────────────────────────────

  private renderGeneralTab(el: HTMLElement): void {
    // ── pi Binary (desktop-only — mobile has no local pi binary) ─────────────
    if (Platform.isDesktop) {
      el.createEl('h3', { text: 'pi Binary' });

      new Setting(el)
        .setName('Path override')
        .setDesc(
          'Leave empty to auto-detect pi from your global npm installation. ' +
            'Set an explicit path if you have multiple pi versions or a custom install ' +
            '(e.g. /opt/homebrew/bin/pi or ~/my-pi/dist/cli.js).',
        )
        .addText((text) =>
          text
            .setPlaceholder('auto-detect (recommended)')
            .setValue(this.plugin.settings.binaryPath)
            .onChange(async (value) => {
              this.plugin.settings.binaryPath = value;
              await this.plugin.saveSettings();
            }),
        )
        .addButton((btn) =>
          btn
            .setButtonText('Check')
            .setCta()
            .onClick(async () => {
              if (!Platform.isDesktop) {
                new Notice('obsidian-pi: pi binary detection is only available in the Obsidian desktop app.', 6000);
                return;
              }
              const binary = await import('../binary');
              btn.setButtonText('Checking…').setDisabled(true);
              try {
                const info = await binary.detectPiBinary(
                  this.plugin.settings.binaryPath || undefined,
                );
                this.plugin.binaryInfo = info;
                new Notice(`✓ pi ${info.version} found`);
              } catch (err) {
                this.plugin.binaryInfo = null;
                new Notice(
                  err instanceof binary.BinaryError ? err.message : String(err),
                  10000,
                );
              } finally {
                this.display();
              }
            }),
        );

      const info = this.plugin.binaryInfo;
      new Setting(el)
        .setName('Detected')
        .setDesc(
          info
            ? buildDetectedDesc(info)
            : 'Not detected — click Check, or install pi: npm install -g @earendil-works/pi-coding-agent',
        )
        .setDisabled(true);

      // Update pi / extensions — runs the matching `pi update` subcommand in a modal.
      new Setting(el)
        .setName('Update')
        .setDesc(
          "Run pi's self-update commands. Output streams into a modal. Uses the " +
            'same launcher as the terminal (start command or detected binary).',
        )
        .addButton((btn) =>
          btn.setButtonText('Update pi').onClick(() => {
            void this.plugin.runPiUpdate(true, false);
          }),
        )
        .addButton((btn) =>
          btn.setButtonText('Update extensions').onClick(() => {
            void this.plugin.runPiUpdate(false, true);
          }),
        )
        .addButton((btn) =>
          btn.setButtonText('Update all').onClick(() => {
            void this.plugin.runPiUpdate(true, true);
          }),
        );

      // Start command — choose how pi is launched (auto-detect vs. a sandbox wrapper like sand-pi).
      const startSetting = new Setting(el)
        .setName('Start command')
        .setDesc(
          'How pi is launched. "pi (auto-detect)" uses the detected binary. ' +
            'Choose "sand-pi" to run the default sandbox at ~/.pi-sandboxes/default/run.sh ' +
            '(an isolated pi with its own agent config). Use "Custom…" to enter any ' +
            'command or wrapper script — the plugin appends its standard pi flags ' +
            '(--model, -e bridge, --session-dir, …) after it.',
        )
        .addDropdown((drop) => {
          const sc = this.plugin.settings.startCommand.trim();
          const preset = sc === '' ? 'pi' : sc === 'sand-pi' ? 'sand-pi' : '__custom__';
          drop
            .addOption('pi', 'pi (auto-detect)')
            .addOption('sand-pi', 'sand-pi (sandbox)')
            .addOption('__custom__', 'Custom…')
            .setValue(preset)
            .onChange(async (value) => {
              if (value === 'pi') this.plugin.settings.startCommand = '';
              else if (value === 'sand-pi') this.plugin.settings.startCommand = 'sand-pi';
              // '__custom__' leaves startCommand as-is so the user can type their own.
              await this.plugin.saveSettings();
              this.display();
            });
        })
        .addText((text) =>
          text
            .setPlaceholder('e.g. ~/.pi-sandboxes/mybox/run.sh')
            .setValue(this.plugin.settings.startCommand)
            .onChange(async (value) => {
              this.plugin.settings.startCommand = value;
              await this.plugin.saveSettings();
            }),
        );
      startSetting.controlEl.querySelector('input')?.setAttribute(
        'aria-label',
        'Custom start command',
      );
    }

    // ── Remote AHP server (mobile + desktop) ───────────────────────────────────
    el.createEl('h3', { text: 'Remote AHP server' });

    new Setting(el)
      .setName('Remote AHP server URL')
      .setDesc(
        'WebSocket endpoint for the AHP server. ' +
          'Use "pi: AHP — open or create remote session" from the command palette to connect.',
      )
      .addText((text) =>
        text
          .setPlaceholder('ws://localhost:4500')
          .setValue(this.plugin.settings.ahpServerUrl)
          .onChange(async (value) => {
            this.plugin.settings.ahpServerUrl = value.trim() || DEFAULT_AHP_SERVER_URL;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('Server token')
      .setDesc(
        'Shared farm token — the same one the AHP server requires for `initialize`. ' +
          'Leave empty if the server has no token configured. ' +
          'If the AHP_SERVER_TOKEN environment variable is set, it takes precedence and this value is not saved to data.json.',
      )
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('optional')
          .setValue(this.plugin.settings.ahpServerToken)
          .onChange(async (value) => {
            this.plugin.settings.ahpServerToken = value.trim();
            await this.plugin.saveSettings();
            this.plugin.hostAgentClient?.updateIdentity(
              this.plugin.settings.hostAgentDeviceName,
              this.plugin.effectiveAhpToken() || undefined,
              this.plugin.binaryInfo?.version,
            );
          });
      });

    // ── Host agent relay (M3) — desktop-only ──────────────────────────────────
    if (Platform.isDesktop) {
      el.createEl('h3', { text: 'Host agent' });

      new Setting(el)
        .setName('Enable host agent')
        .setDesc(
          'Register this Mac\'s local pi instances with the Farm View server as a ' +
            'host agent, so remote clients can view and attach to their terminals. ' +
            'Desktop only.',
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.hostAgentEnabled)
            .onChange(async (value) => {
              this.plugin.settings.hostAgentEnabled = value;
              await this.plugin.saveSettings();
              if (value) void this.plugin.startHostAgentClient();
              else await this.plugin.stopHostAgentClient();
              this.display();
            }),
        );

      new Setting(el)
        .setName('Device name')
        .setDesc('How this Mac identifies itself in the Farm catalogue (hostAgent.register deviceName).')
        .addText((text) =>
          text
            .setPlaceholder('Voyager')
            .setValue(this.plugin.settings.hostAgentDeviceName)
            .onChange(async (value) => {
              this.plugin.settings.hostAgentDeviceName = value.trim() || 'Voyager';
              await this.plugin.saveSettings();
              this.plugin.hostAgentClient?.updateIdentity(
                this.plugin.settings.hostAgentDeviceName,
                this.plugin.effectiveAhpToken() || undefined,
                this.plugin.binaryInfo?.version,
              );
            }),
        );

      const host = this.plugin.hostAgentClient;
      const hostStatus = host
        ? host.state === 'connected'
          ? `Connected · hostAgentId ${host.agentId ?? '…'} · ${host.announcedIds.size} instance(s) announced` +
            (host.lastSyncAtMs ? ` · last sync ${new Date(host.lastSyncAtMs).toLocaleTimeString()}` : '')
          : `${host.state} — reconnecting…`
        : this.plugin.settings.hostAgentEnabled
          ? 'Connecting…'
          : 'Disabled — enable above to register this Mac\'s pi instances.';
      new Setting(el)
        .setName('Status')
        .setDesc(hostStatus)
        .setDisabled(true);
    }

    // ── Agent ────────────────────────────────────────────────────────────────
    el.createEl('h3', { text: 'Agent' });

    new Setting(el)
      .setName('Default model')
      .setDesc(
        'Model name passed to the agent on startup (e.g. claude-sonnet-4-5). ' +
          'Empty = pi uses its own configured default.',
      )
      .addText((text) =>
        text
          .setPlaceholder('claude-sonnet-4-5')
          .setValue(this.plugin.settings.defaultModel)
          .onChange(async (value) => {
            this.plugin.settings.defaultModel = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('Thinking level')
      .setDesc('Default thinking intensity for the agent.')
      .addDropdown((drop) =>
        drop
          .addOption('none', 'None')
          .addOption('low', 'Low')
          .addOption('medium', 'Medium (default)')
          .addOption('high', 'High')
          .setValue(this.plugin.settings.thinkingLevel)
          .onChange(async (value) => {
            this.plugin.settings.thinkingLevel =
              value as ObsidianPiSettings['thinkingLevel'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('Agent directory')
      .setDesc(
        'Default pi agent directory (extensions, skills, prompts). ' +
          'Empty = pi defaults to ~/.pi. Per-instance overrides are available in the Terminal tab.',
      )
      .addText((text) =>
        text
          .setPlaceholder('~/.pi')
          .setValue(this.plugin.settings.agentDir)
          .onChange(async (value) => {
            this.plugin.settings.agentDir = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // ── Session persistence (Phase 9) ───────────────────────────────────────
    el.createEl('h3', { text: 'Sessions' });

    new Setting(el)
      .setName('Restore session on restart')
      .setDesc(
        'Remember the last active pi session (chat and/or terminal) and reload it ' +
          'when Obsidian restarts, so your conversation history is preserved across ' +
          'restarts. When off, a fresh session starts every time.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.restoreSessionOnRestart).onChange(async (value) => {
          this.plugin.settings.restoreSessionOnRestart = value;
          await this.plugin.saveSettings();
          // Clearing the saved session paths when disabled prevents a stale restore
          // for both the chat (RPC) and terminal (PTY) surfaces.
          if (!value) {
            this.plugin.settings.lastSessionFile = null;
            this.plugin.settings.lastTerminalSessionFile = null;
            for (const inst of this.plugin.settings.instances) {
              inst.lastSessionFile = undefined;
            }
            await this.plugin.saveSettings();
          }
        }),
      );

    // ── Agent notifications ───────────────────────────────────────────────────
    el.createEl('h3', { text: 'Agent notifications' });

    new Setting(el)
      .setName('Notification mode')
      .setDesc(
        'How to notify when the pi agent finishes a turn, errors, aborts, or is ' +
          'waiting for your input. In-app notices use Obsidian; OS notifications use ' +
          'the native desktop notification panel.',
      )
      .addDropdown((drop) =>
        drop
          .addOption('off', 'Off')
          .addOption('inApp', 'In-app Notice')
          .addOption('os', 'OS Notification')
          .addOption('both', 'Both')
          .setValue(this.plugin.settings.agentNotificationMode)
          .onChange(async (value) => {
            this.plugin.settings.agentNotificationMode =
              value as ObsidianPiSettings['agentNotificationMode'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('Play sound on notification')
      .setDesc('Emit the system sound when a native OS notification is shown.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.agentNotificationSound).onChange(async (value) => {
          this.plugin.settings.agentNotificationSound = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName('Notify only when Obsidian is unfocused')
      .setDesc('Suppress native OS notifications while the Obsidian window is focused.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.agentNotificationFocusOnly).onChange(async (value) => {
          this.plugin.settings.agentNotificationFocusOnly = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName('Reply from notification')
      .setDesc(
        'When the agent asks a question (question_user, confirm, input), show its ' +
          'options as action buttons and let you type an answer directly in the OS ' +
          'notification — no need to switch back to Obsidian. macOS only.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.agentNotificationInteractive).onChange(async (value) => {
          this.plugin.settings.agentNotificationInteractive = value;
          await this.plugin.saveSettings();
        }),
      );

    // ── Menu bar (macOS tray) — desktop-only ─────────────────────────────────
    if (Platform.isDesktop) {
      el.createEl('h3', { text: 'Menu bar (macOS tray)' });

      new Setting(el)
        .setName('Show menu-bar icon')
        .setDesc(
          'Add a macOS menu-bar (tray) icon that lists every pi terminal ' +
            'instance across all open Obsidian apps, grouped by vault. One icon is ' +
            'shared across apps via a local socket: the first plugin instance to ' +
            'start owns the icon and others report their state to it. macOS only.',
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.menubarEnabled)
            .onChange(async (value) => {
              this.plugin.settings.menubarEnabled = value;
              await this.plugin.saveSettings();
              this.plugin.startMenubar();
            }),
        );

      new Setting(el)
        .setName('Show idle instances')
        .setDesc('List idle and not-yet-started instances in the tray menu. When off, only instances with live agent activity are shown.')
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.menubarShowIdleInstances).onChange(async (value) => {
            this.plugin.settings.menubarShowIdleInstances = value;
            await this.plugin.saveSettings();
            this.plugin.instanceManager?.notifyChanged();
          }),
        );

      new Setting(el)
        .setName('Icon style')
        .setDesc(
          'How the Obsidian icon is rendered in the menu bar. Template adapts automatically ' +
            'to light/dark menu bars; the accent styles use your configured Obsidian accent color ' +
            '(Settings → Appearance → Accent color) for the stone and its outline. Only the app ' +
            'currently holding the tray icon renders this — other apps apply it if they take over.',
        );
      this.renderIconStylePicker(el);
    }
  }

  /**
   * Visual picker for `menubarIconStyle`: renders all three styles as live
   * thumbnails (via the same {@link renderObsidianIconDataUrl} the tray icon
   * uses) with the current Obsidian accent color, so you can compare them
   * before choosing. Clicking a thumbnail selects it immediately.
   */
  private renderIconStylePicker(el: HTMLElement): void {
    const wrapper = el.createDiv({ cls: 'pi-menubar-icon-picker' });

    const refresh = (): void => {
      const accent = resolveAccentColor();
      wrapper.empty();
      for (const style of MENUBAR_ICON_STYLES) {
        const selected = this.plugin.settings.menubarIconStyle === style;
        const option = wrapper.createDiv({
          cls: 'pi-menubar-icon-option' + (selected ? ' is-selected' : ''),
          attr: { role: 'button', 'aria-label': MENUBAR_ICON_STYLE_LABELS[style] },
        });
        const img = option.createEl('img', {
          attr: { width: '36', height: '36', alt: MENUBAR_ICON_STYLE_LABELS[style] },
        });
        img.src = renderObsidianIconDataUrl(72, style, accent);
        option.createDiv({ cls: 'pi-menubar-icon-option-label', text: MENUBAR_ICON_STYLE_LABELS[style] });
        option.addEventListener('click', () => {
          void (async (): Promise<void> => {
            if (this.plugin.settings.menubarIconStyle === style) return;
            this.plugin.settings.menubarIconStyle = style as MenubarIconStyle;
            await this.plugin.saveSettings();
            this.plugin.instanceManager?.notifyChanged();
            refresh();
          })();
        });
      }
    };
    refresh();

    // Catch live accent-color edits made in Appearance settings while this tab
    // is open (those don't go through our plugin's settings, so there's no
    // change event to hook — poll cheaply instead).
    this.iconPreviewRefreshTimer = window.setInterval(refresh, 1500);
  }

  // ── Terminal tab: terminal view + floating prompt editor ─────────────────────

  private renderTerminalTab(el: HTMLElement): void {
    // Local-instance management (add/rename/remove, per-instance cwd/model) is
    // desktop-only — mobile has no local pi instances.
    if (Platform.isDesktop) {
      this.renderInstancesSection(el);
    }

    new Setting(el)
      .setName('Terminal font family')
      .setDesc('CSS font-family for the embedded terminal. Empty = monospace default.')
      .addText((text) =>
        text
          .setPlaceholder('var(--font-monospace)')
          .setValue(this.plugin.settings.terminalFontFamily)
          .onChange(async (value) => {
            this.plugin.settings.terminalFontFamily = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('Terminal font size')
      .setDesc('Font size (px) for the embedded xterm.js terminal. Applied live.')
      .addText((text) =>
        text
          .setPlaceholder('13')
          .setValue(String(this.plugin.settings.terminalFontSize))
          .onChange(async (value) => {
            const n = Number.parseInt(value, 10);
            if (!Number.isNaN(n) && n >= 6 && n <= 64) {
              this.plugin.settings.terminalFontSize = n;
              await this.plugin.saveSettings();
              this.plugin.instanceManager.get('default')?.terminalView?.setFontSize(n);
            }
          }),
      );

    new Setting(el)
      .setName('Prompt editor font size')
      .setDesc('Font size (px) for the floating prompt editor (Live Preview + Reading view). Applied live.')
      .addText((text) =>
        text
          .setPlaceholder('16')
          .setValue(String(this.plugin.settings.promptEditorFontSize))
          .onChange(async (value) => {
            const n = Number.parseInt(value, 10);
            if (!Number.isNaN(n) && n >= 6 && n <= 96) {
              this.plugin.settings.promptEditorFontSize = n;
              await this.plugin.saveSettings();
              this.plugin.instanceManager.getPromptPopout('default')?.setEditorFontSize(n);
            }
          }),
      );

    new Setting(el)
      .setName('Terminal scrollback')
      .setDesc('Number of lines retained in the terminal scrollback buffer.')
      .addText((text) =>
        text
          .setPlaceholder('5000')
          .setValue(String(this.plugin.settings.terminalScrollback))
          .onChange(async (value) => {
            const n = Number.parseInt(value, 10);
            if (!Number.isNaN(n) && n >= 0) {
              this.plugin.settings.terminalScrollback = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(el)
      .setName('Prompt submit mode')
      .setDesc(
        'How the floating prompt editor submits text to pi over the PTY. ' +
          'APC marker (default) or bracketed-paste fallback. Switch to paste only ' +
          'if the APC marker ever fails to pass through.',
      )
      .addDropdown((drop) =>
        drop
          .addOption('apc', 'APC marker (recommended)')
          .addOption('paste', 'Bracketed-paste fallback')
          .setValue(this.plugin.settings.promptSubmitMode)
          .onChange(async (value) => {
            this.plugin.settings.promptSubmitMode = value as ObsidianPiSettings['promptSubmitMode'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('Prompt note')
      .setDesc(
        'Each instance has its own dedicated prompt note named after the instance ' +
        '(e.g. “pi prompt — Default.md”), stored in a hidden folder inside the plugin ' +
        '(.obsidian/plugins/obsidian-pi/prompts/) — not shown in the file explorer. ' +
        'Renaming the instance renames its note.',
      );

    new Setting(el)
      .setName('Prompt surface')
      .setDesc('Where the prompt editor opens: a floating popout window, docked in the main Obsidian window, or rendered as a resizable bottom panel inside the pi terminal view.')
      .addDropdown((drop) =>
        drop
          .addOption('popout', 'Floating popout window')
          .addOption('docked', 'Docked in main window')
          .addOption('embedded', 'Embedded (bottom panel)')
          .setValue(this.plugin.settings.promptSurface)
          .onChange(async (value) => {
            this.plugin.settings.promptSurface = value as ObsidianPiSettings['promptSurface'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('Open prompt editor on startup')
      .setDesc(
        'Open the prompt editor automatically when Obsidian finishes loading — but ' +
          'only if it isn\'t already open. A prompt note restored from the previous ' +
          'session is always reconnected to the TUI automatically (regardless of this ' +
          'setting); this only controls spawning a new one when none is open.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.promptOpenOnLoad).onChange(async (value) => {
          this.plugin.settings.promptOpenOnLoad = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName('Prompt popout width')
      .setDesc('Floating prompt window width in pixels.')
      .addText((text) =>
        text
          .setPlaceholder('560')
          .setValue(String(this.plugin.settings.promptPopoutWidth))
          .onChange(async (value) => {
            const n = Number.parseInt(value, 10);
            if (!Number.isNaN(n) && n >= 240) {
              this.plugin.settings.promptPopoutWidth = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(el)
      .setName('Prompt popout height')
      .setDesc('Floating prompt window height in pixels.')
      .addText((text) =>
        text
          .setPlaceholder('480')
          .setValue(String(this.plugin.settings.promptPopoutHeight))
          .onChange(async (value) => {
            const n = Number.parseInt(value, 10);
            if (!Number.isNaN(n) && n >= 160) {
              this.plugin.settings.promptPopoutHeight = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(el)
      .setName('Clear prompt on submit')
      .setDesc('Empty the scratch note after each prompt is sent to pi.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.clearPromptOnSubmit).onChange(async (value) => {
          this.plugin.settings.clearPromptOnSubmit = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName('Hide prompt note in file explorer')
      .setDesc('Keep the scratch prompt note out of the Obsidian file explorer.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hidePromptNoteInExplorer).onChange(async (value) => {
          this.plugin.settings.hidePromptNoteInExplorer = value;
          await this.plugin.saveSettings();
          this.plugin.setPromptNoteHidden(value);
        }),
      );
  }

  // ── Auth & Providers tab ─────────────────────────────────────────────────────

  private renderAuthTab(el: HTMLElement): void {
    new Setting(el)
      .setName('Auth strategy')
      .setDesc(
        '"Delegate to pi" (recommended): pi resolves credentials from its own ' +
          'auth.json (~/.pi/agent/auth.json) and environment variables — the plugin ' +
          'holds no secrets. ' +
          '"Runtime API key": supply ANTHROPIC_API_KEY here; it is passed to the ' +
          'subprocess environment only and never written to disk or the vault.',
      )
      .addDropdown((drop) =>
        drop
          .addOption('delegate', 'Delegate to pi (recommended)')
          .addOption('runtime-key', 'Runtime API key (not persisted)')
          .setValue(this.plugin.settings.authStrategy)
          .onChange(async (value) => {
            this.plugin.settings.authStrategy = value as ObsidianPiSettings['authStrategy'];
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    // ── Providers, models & pi settings (Phase 8 SDK bridge) ─────────────────
    el.createEl('h3', { text: 'Providers, models & pi settings' });

    new Setting(el)
      .setName('Providers & auth')
      .setDesc(
        'Manage API keys and OAuth logins per provider — replaces the pi TUI\'s ' +
          '/login and /logout. Requires pi installed as a Node script (npm global install).',
      )
      .addButton((btn) =>
        btn.setButtonText('Manage providers').onClick(() => {
          new ProviderPanel(this.app, this.plugin).open();
        }),
      );

    new Setting(el)
      .setName('Model browser')
      .setDesc('Browse available models per provider and set the default model.')
      .addButton((btn) =>
        btn.setButtonText('Browse models').onClick(() => {
          new ModelBrowserModal(this.app, this.plugin).open();
        }),
      );

    new Setting(el)
      .setName('pi settings.json')
      .setDesc(
        'View and edit pi\'s own settings (default model/thinking, compaction, ' +
          'trust, warnings) — replaces the TUI\'s /settings.',
      )
      .addButton((btn) =>
        btn.setButtonText('Open pi settings').onClick(() => {
          new SettingsBridgeModal(this.app, this.plugin).open();
        }),
      );

    if (this.plugin.settings.authStrategy === 'runtime-key') {
      new Setting(el)
        .setName('ANTHROPIC_API_KEY')
        .setDesc(
          '⚠️ Held in memory only — never saved to disk or the vault. ' +
            'You will need to re-enter it each time Obsidian restarts.',
        )
        .addText((text) => {
          text.inputEl.type = 'password';
          text
            .setPlaceholder('sk-ant-…')
            .setValue(this.plugin.runtimeApiKey)
            .onChange((value) => {
              this.plugin.runtimeApiKey = value.trim();
            });
        });
    }
  }

  // ── Instances section (Phase 10) ───────────────────────────────────────────

  private renderInstancesSection(el: HTMLElement): void {
    const h3 = el.createEl('h3', { text: 'Terminal instances' });
    h3.id = 'pi-settings-instances';
    const desc = el.createEl('p', {
      cls: 'pi-settings-desc',
      text:
        'Each instance is an independent pi terminal with its own working directory. ' +
        'The "default" instance preserves legacy paths and behavior.',
    });
    desc.style.marginBottom = '1em';

    const carousel = el.createDiv({ cls: 'pi-instances-carousel' });
    const instances = this.plugin.settings.instances;
    instances.forEach((instance, index) => {
      this.renderInstanceCard(carousel, instance, index);
    });

    const addCard = carousel.createDiv({
      cls: 'pi-instance-card pi-instance-card-add',
      attr: { role: 'button', 'aria-label': 'Add instance', title: 'Add instance' },
    });
    addCard.createSpan({ cls: 'pi-instance-add-glyph', text: '+' });
    addCard.createSpan({ cls: 'pi-instance-add-label', text: 'Add instance' });
    addCard.addEventListener('click', () => {
      void addInstanceInteractive(this.plugin).then(() => this.display());
    });
  }

  private renderInstanceCard(
    container: HTMLElement,
    instance: PiInstanceConfig,
    index: number,
  ): void {
    const card = container.createDiv({ cls: 'pi-instance-card' });

    card.createEl('div', {
      cls: 'pi-instance-card-name',
      text: instance.id === 'default' ? 'Default instance' : `Instance ${index + 1}`,
    });

    const isDefault = instance.id === 'default';

    new Setting(card)
      .setName('Name')
      .setDesc('Label shown in the UI.')
      .addText((text) =>
        text.setValue(instance.name).onChange(async (value) => {
          instance.name = value.trim() || instance.name;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    new Setting(card)
      .setName('Working directory')
      .setDesc('Absolute path where pi runs for this instance.')
      .addText((text) => {
        text.setPlaceholder('/path/to/project').setValue(instance.cwd);
        text.inputEl.style.flex = '1 1 auto';
        text.onChange(async (value) => {
          instance.cwd = value.trim();
          await this.plugin.saveSettings();
        });
      })
      .addButton((btn) =>
        btn.setButtonText('Browse').onClick(async () => {
          const picked = await browseDirectory(this.plugin, instance.cwd);
          if (picked != null) {
            instance.cwd = picked;
            await this.plugin.saveSettings();
            this.display();
          }
        }),
      );

    const promptNoteHint = card.createEl('div', {
      cls: 'pi-instance-hint',
      text: `Prompt note: ${instancePromptNotePath(this.plugin, instance)}`,
    });
    promptNoteHint.style.fontSize = '0.85em';
    promptNoteHint.style.color = 'var(--text-muted)';
    promptNoteHint.style.marginTop = '-6px';
    promptNoteHint.style.marginBottom = '10px';

    new Setting(card)
      .setName('Model override')
      .setDesc('Optional model for this instance. Empty uses the global default.')
      .addText((text) =>
        text
          .setPlaceholder('e.g. claude-sonnet-4-5')
          .setValue(instance.model ?? '')
          .onChange(async (value) => {
            instance.model = value.trim() || undefined;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(card)
      .setName('Agent directory override')
      .setDesc('Optional pi agent directory for this instance. Empty uses the global default.')
      .addText((text) =>
        text
          .setPlaceholder('~/.pi')
          .setValue(instance.agentDir ?? '')
          .onChange(async (value) => {
            instance.agentDir = value.trim() || undefined;
            await this.plugin.saveSettings();
          }),
      );

    if (!isDefault) {
      new Setting(card)
        .setName('Remove instance')
        .setDesc('Delete this instance configuration. Its terminal session files are kept on disk.')
        .addButton((btn) =>
          btn
            .setButtonText('Remove')
            .setWarning()
            .onClick(() => {
              void removeInstanceInteractive(this.plugin).then((removed) => {
                if (removed) this.display();
              });
            }),
        );
    }
  }

  // ── Farm View tab (Phase 2 Run 2, server push Phase 3) ─────────────────────

  private async pushFarmServerSettings(): Promise<void> {
    const client = this.plugin.ahpClient;
    if (!client || client.state !== 'connected') return;
    const farm = this.plugin.settings.farmView;
    try {
      await client.setProviderCaps(farm.perProviderCaps);
    } catch (err) {
      console.error('[SettingsTab] failed to push provider caps:', err);
    }
    try {
      await client.setAutoCullConfig(farm.autoCullIdleMinutes);
    } catch (err) {
      console.error('[SettingsTab] failed to push auto-cull config:', err);
    }
  }

  private renderFarmTab(el: HTMLElement): void {
    el.createEl('h3', { text: 'Farm View' });

    const farm = this.plugin.settings.farmView;

    new Setting(el)
      .setName('Default sort')
      .setDesc('How sessions are ordered when the Farm view opens.')
      .addDropdown((drop) =>
        drop
          .addOption('modifiedAt-desc', 'Modified (newest first)')
          .addOption('status', 'Status')
          .addOption('cost', 'Cost')
          .addOption('model', 'Model')
          .setValue(farm.defaultSort)
          .onChange(async (value) => {
            farm.defaultSort = value as typeof farm.defaultSort;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('Density')
      .setDesc('Compact squeezes more rows onto the screen; normal matches the rest of the settings.')
      .addDropdown((drop) =>
        drop
          .addOption('compact', 'Compact')
          .addOption('normal', 'Normal')
          .setValue(farm.density)
          .onChange(async (value) => {
            farm.density = value as typeof farm.density;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('Visible columns')
      .setDesc('Which columns appear in the Farm table. Order is fixed for now; uncheck to hide.')
      .addButton((btn) => {
        btn.setButtonText('Reset columns').onClick(async () => {
          farm.columnVisibility = [
            'name',
            'status',
            'modifiedAt',
            'workingDirectory',
            'model',
            'tokens',
            'cost',
            'turns',
            'activity',
            'subagents',
            'actions',
          ];
          await this.plugin.saveSettings();
          this.display();
        });
      });

    const columnBox = el.createDiv({ cls: 'pi-farm-column-box' });
    const visibleSet = new Set(farm.columnVisibility);
    for (const col of [
      { id: 'name', label: 'Name' },
      { id: 'status', label: 'Status' },
      { id: 'modifiedAt', label: 'Last edit' },
      { id: 'workingDirectory', label: 'Working dir' },
      { id: 'model', label: 'Model' },
      { id: 'tokens', label: 'Tokens' },
      { id: 'cost', label: 'Cost' },
      { id: 'turns', label: 'Turns' },
      { id: 'activity', label: 'Activity' },
      { id: 'subagents', label: 'Subagents' },
      { id: 'actions', label: 'Actions' },
    ]) {
      const row = columnBox.createDiv({ cls: 'pi-farm-column-row' });
      const checkbox = row.createEl('input', { type: 'checkbox' });
      checkbox.checked = visibleSet.has(col.id);
      checkbox.addEventListener('change', () => {
        void (async () => {
          if (checkbox.checked) {
            if (!farm.columnVisibility.includes(col.id)) {
              farm.columnVisibility.push(col.id);
            }
          } else {
            farm.columnVisibility = farm.columnVisibility.filter((id) => id !== col.id);
          }
          await this.plugin.saveSettings();
        })();
      });
      row.createSpan({ text: col.label });
    }

    new Setting(el)
      .setName('Live updates')
      .setDesc('Keep the Farm table in sync with the AHP server automatically.')
      .addToggle((toggle) =>
        toggle.setValue(farm.liveUpdate).onChange(async (value) => {
          farm.liveUpdate = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName('Cost alert threshold')
      .setDesc('Soft notification threshold for session cost. 0 disables the alert.')
      .addText((text) =>
        text
          .setPlaceholder('0')
          .setValue(String(farm.costAlertThreshold))
          .onChange(async (value) => {
            const n = Number.parseFloat(value);
            if (!Number.isNaN(n) && n >= 0) {
              farm.costAlertThreshold = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(el)
      .setName('Auto-cull idle minutes')
      .setDesc('Sessions idle longer than this may be culled automatically. Leave empty to disable.')
      .addText((text) =>
        text
          .setPlaceholder('disabled')
          .setValue(farm.autoCullIdleMinutes != null ? String(farm.autoCullIdleMinutes) : '')
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed === '') {
              farm.autoCullIdleMinutes = null;
            } else {
              const n = Number.parseInt(trimmed, 10);
              if (!Number.isNaN(n) && n >= 0) {
                farm.autoCullIdleMinutes = n;
              }
            }
            await this.plugin.saveSettings();
            await this.pushFarmServerSettings();
          }),
      );

    new Setting(el)
      .setName('Group by project')
      .setDesc('Group sessions by their working directory project name in the Farm table.')
      .addToggle((toggle) =>
        toggle.setValue(farm.groupByProject).onChange(async (value) => {
          farm.groupByProject = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName('Always-show devices')
      .setDesc(
        'Comma-separated device names that always appear in the Farm View "Registered Devices" header, ' +
          'even when offline or disconnected. The local device is always shown. New external hosts are auto-added.',
      )
      .addText((text) =>
        text
          .setPlaceholder('e.g. ulysse, arthur, voyager')
          .setValue((this.plugin.settings.knownDevices ?? []).join(', '))
          .onChange(async (value) => {
            const names = value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            // Preserve order but deduplicate.
            const seen = new Set<string>();
            this.plugin.settings.knownDevices = names.filter((n) => {
              if (seen.has(n)) return false;
              seen.add(n);
              return true;
            });
            await this.plugin.saveSettings();
            this.plugin.refreshFarmViews();
          }),
      );

    el.createEl('h3', { text: 'Provider concurrency caps' });
    const capDesc = el.createEl('p', {
      cls: 'pi-settings-desc',
      text:
        'Per-provider max-concurrency caps are pushed to the AHP server as you edit them. ' +
        'The server enforces them as the source of truth.',
    });
    capDesc.style.marginBottom = '1em';

    const capContainer = el.createDiv({ cls: 'pi-farm-cap-editor' });
    const renderCaps = (): void => {
      capContainer.empty();
      const providers = Object.keys(farm.perProviderCaps);
      if (providers.length === 0) {
        capContainer.createEl('div', { cls: 'pi-farm-cap-empty', text: 'No caps configured.' });
      }
      for (const provider of providers) {
        const row = capContainer.createDiv({ cls: 'pi-farm-cap-row' });
        row.createEl('span', { cls: 'pi-farm-cap-provider', text: provider });
        const numInput = row.createEl('input', { type: 'number' });
        numInput.value = String(farm.perProviderCaps[provider]);
        numInput.addEventListener('change', () => {
          void (async () => {
            const n = Number.parseInt(numInput.value, 10);
            if (!Number.isNaN(n) && n >= 0) {
              farm.perProviderCaps[provider] = n;
              await this.plugin.saveSettings();
              await this.pushFarmServerSettings();
            }
          })();
        });
        const removeBtn = row.createEl('button', {
          cls: 'pi-farm-cap-remove',
          text: 'Remove',
        });
        removeBtn.addEventListener('click', () => {
          void (async () => {
            delete farm.perProviderCaps[provider];
            await this.plugin.saveSettings();
            await this.pushFarmServerSettings();
            renderCaps();
          })();
        });
      }
    };
    renderCaps();

    const addRow = el.createDiv({ cls: 'pi-farm-cap-add-row' });
    const providerInput = addRow.createEl('input', { type: 'text', placeholder: 'Provider name' });
    const maxInput = addRow.createEl('input', { type: 'number', placeholder: 'Max' });
    const addBtn = addRow.createEl('button', { text: 'Add cap' });
    addBtn.addEventListener('click', () => {
      void (async () => {
        const provider = providerInput.value.trim();
        const max = Number.parseInt(maxInput.value, 10);
        if (provider && !Number.isNaN(max) && max >= 0) {
          farm.perProviderCaps[provider] = max;
          providerInput.value = '';
          maxInput.value = '';
          await this.plugin.saveSettings();
          await this.pushFarmServerSettings();
          renderCaps();
        }
      })();
    });
  }

  // ── Prompt & Voice tab: floating prompt editor + dictation ───────────────────

  private renderPromptVoiceTab(el: HTMLElement): void {
    el.createEl('h3', { text: 'Voice dictation' });

    new Setting(el)
      .setName('STT server URL')
      .setDesc('Base URL of the self-hosted Whisper sidecar (Tailscale-only).')
      .addText((text) =>
        text
          .setPlaceholder('http://localhost:7440')
          .setValue(this.plugin.settings.sttServerUrl)
          .onChange(async (value) => {
            this.plugin.settings.sttServerUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('STT bearer token')
      .setDesc(
        'Bearer token shared with the sidecar (WHISPER_STT_TOKEN). ' +
          'If the STT_TOKEN (or WHISPER_STT_TOKEN) environment variable is set, it takes precedence and this value is not saved to data.json.',
      )
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('optional')
          .setValue(this.plugin.settings.sttToken)
          .onChange(async (value) => {
            this.plugin.settings.sttToken = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(el)
      .setName('Language')
      .setDesc('Auto-detect usually works; forcing a language is more accurate on short clips.')
      .addDropdown((drop) =>
        drop
          .addOption('auto', 'Auto-detect')
          .addOption('en', 'English')
          .addOption('fr', 'French')
          .setValue(this.plugin.settings.sttLanguage)
          .onChange(async (value) => {
            this.plugin.settings.sttLanguage = value as ObsidianPiSettings['sttLanguage'];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('Model override')
      .setDesc('Optional Whisper model (tiny | base | small). Leave empty to use the sidecar default.')
      .addText((text) =>
        text
          .setPlaceholder('base')
          .setValue(this.plugin.settings.sttModel)
          .onChange(async (value) => {
            this.plugin.settings.sttModel = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName('Auto-submit after dictation')
      .setDesc('Send the transcribed text to pi immediately after inserting it into the prompt editor.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.sttAutoSubmit).onChange(async (value) => {
          this.plugin.settings.sttAutoSubmit = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}

function buildDetectedDesc(info: import('../binary').BinaryInfo): string {
  const parts: string[] = [`pi ${info.version}`];
  if (info.nodeExe) parts.push(`node: ${info.nodeExe}`);
  parts.push(info.path);
  return parts.join(' · ');
}

/**
 * Fallback directory picker: fuzzy-search directories directly under a base path.
 * Returns the absolute path of the selected directory.
 */

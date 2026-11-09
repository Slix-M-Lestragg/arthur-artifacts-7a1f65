/**
 * SettingsBridgeModal — view/edit pi's settings.json via the SDK bridge.
 * Replaces the TUI's `/settings` for the plugin. Covers the fields called out
 * in the ROADMAP: default model, thinking level, compaction, trust, warnings.
 *
 * Setters on SettingsManager update in-memory state immediately and queue an
 * async disk write; we call flush() explicitly on Save for a durability
 * boundary, and surface drainErrors() as a Notice if persistence failed.
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import type ObsidianPiPlugin from '../main';
import type { AuthBridge, SettingsSnapshot } from '../transport/AuthBridge';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const TRUST_LEVELS = ['ask', 'always', 'never'] as const;

export class SettingsBridgeModal extends Modal {
  private bridge: AuthBridge | null = null;
  private snapshot: SettingsSnapshot | null = null;
  private overrides: Record<string, unknown> = {};

  constructor(app: App, private readonly plugin: ObsidianPiPlugin) {
    super(app);
    this.titleEl.setText('pi: Settings');
  }

  onOpen(): void {
    this.contentEl.createDiv({ cls: 'pi-settings-loading', text: 'Loading…' });
    void this.load();
  }

  onClose(): void {
    this.plugin.releaseAuthBridge();
    this.bridge = null;
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    this.bridge = await this.plugin.ensureAuthBridge();
    if (!this.bridge) {
      this.contentEl.empty();
      this.contentEl.createDiv({ cls: 'pi-empty-state', text: 'Auth bridge unavailable — see the Notice above for details.' });
      return;
    }
    try {
      this.snapshot = await this.bridge.getSettings();
      this.overrides = {};
      this.render();
    } catch (err) {
      this.contentEl.empty();
      new Notice(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`, 6000);
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const g = this.snapshot?.global ?? {};

    new Setting(contentEl)
      .setName('Default model')
      .setDesc('Model id used when no model is explicitly set (e.g. claude-sonnet-4-5).')
      .addText((text) =>
        text
          .setPlaceholder('claude-sonnet-4-5')
          .setValue((g['defaultModel'] as string) ?? '')
          .onChange((value) => { this.overrides.defaultModel = value.trim() || undefined; }),
      );

    new Setting(contentEl)
      .setName('Default provider')
      .addText((text) =>
        text
          .setPlaceholder('anthropic')
          .setValue((g['defaultProvider'] as string) ?? '')
          .onChange((value) => { this.overrides.defaultProvider = value.trim() || undefined; }),
      );

    new Setting(contentEl)
      .setName('Default thinking level')
      .addDropdown((drop) => {
        drop.addOption('', '(unset)');
        for (const level of THINKING_LEVELS) drop.addOption(level, level);
        drop.setValue((g['defaultThinkingLevel'] as string) ?? '');
        drop.onChange((value) => { this.overrides.defaultThinkingLevel = value || undefined; });
      });

    const compaction = (g['compaction'] as { enabled?: boolean } | undefined) ?? {};
    new Setting(contentEl)
      .setName('Auto-compaction enabled')
      .addToggle((toggle) =>
        toggle.setValue(compaction.enabled ?? true).onChange((value) => {
          this.overrides.compaction = { ...(this.overrides.compaction as object), enabled: value };
        }),
      );

    new Setting(contentEl)
      .setName('Default project trust')
      .setDesc('Whether new project directories are trusted to run tools automatically.')
      .addDropdown((drop) => {
        drop.addOption('', '(unset)');
        for (const level of TRUST_LEVELS) drop.addOption(level, level);
        drop.setValue((g['defaultProjectTrust'] as string) ?? '');
        drop.onChange((value) => { this.overrides.defaultProjectTrust = value || undefined; });
      });

    const warnings = (g['warnings'] as { anthropicExtraUsage?: boolean } | undefined) ?? {};
    new Setting(contentEl)
      .setName('Warn on Anthropic extra usage')
      .addToggle((toggle) =>
        toggle.setValue(warnings.anthropicExtraUsage ?? true).onChange((value) => {
          this.overrides.warnings = { ...(this.overrides.warnings as object), anthropicExtraUsage: value };
        }),
      );

    const actions = contentEl.createDiv({ cls: 'pi-settings-actions' });
    const saveBtn = actions.createEl('button', { cls: 'mod-cta', text: 'Save' });
    saveBtn.addEventListener('click', () => void this.handleSave());
    const closeBtn = actions.createEl('button', { text: 'Close' });
    closeBtn.addEventListener('click', () => this.close());
  }

  private async handleSave(): Promise<void> {
    if (!this.bridge) return;
    if (Object.keys(this.overrides).length === 0) {
      new Notice('No changes to save', 2000);
      return;
    }
    try {
      // Strip undefined values — applyOverrides merges Partial<Settings>.
      const cleaned = Object.fromEntries(
        Object.entries(this.overrides).filter(([, v]) => v !== undefined),
      );
      await this.bridge.applySettingsOverrides(cleaned);
      await this.bridge.flushSettings();
      const errors = await this.bridge.drainErrors();
      if (errors.settings.length > 0) {
        new Notice(`Settings saved with errors: ${errors.settings.map((e) => e.message).join('; ')}`, 8000);
      } else {
        new Notice('Settings saved', 2500);
      }
      await this.load();
    } catch (err) {
      new Notice(`Failed to save settings: ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }
}

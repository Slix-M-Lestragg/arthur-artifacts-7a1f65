/**
 * ModelBrowserModal — browse all/available models per provider via the SDK
 * bridge's ModelRegistry, filter by provider/capability, and set the default
 * model (persisted via SettingsManager, independent of any live RPC session).
 */

import { App, DropdownComponent, Modal, Notice } from 'obsidian';
import type ObsidianPiPlugin from '../main';
import type { AuthBridge, BridgeModel } from '../transport/AuthBridge';

export class ModelBrowserModal extends Modal {
  private bridge: AuthBridge | null = null;
  private allModels: BridgeModel[] = [];
  private availableModels: BridgeModel[] = [];
  private showAvailableOnly = true;
  private providerFilter = '';
  private capabilityFilter: 'any' | 'reasoning' | 'image' = 'any';
  private listEl!: HTMLElement;

  constructor(app: App, private readonly plugin: ObsidianPiPlugin) {
    super(app);
    this.titleEl.setText('pi: Model browser');
  }

  onOpen(): void {
    this.contentEl.addClass('pi-model-browser');
    this.contentEl.createDiv({ cls: 'pi-model-loading', text: 'Loading…' });
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
      [this.allModels, this.availableModels] = await Promise.all([
        this.bridge.getAllModels(),
        this.bridge.getAvailableModels(),
      ]);
      this.renderShell();
    } catch (err) {
      this.contentEl.empty();
      new Notice(`Failed to load models: ${err instanceof Error ? err.message : String(err)}`, 6000);
    }
  }

  private renderShell(): void {
    const { contentEl } = this;
    contentEl.empty();

    const filters = contentEl.createDiv({ cls: 'pi-model-filters' });

    const availToggle = filters.createEl('label', { cls: 'pi-model-filter-toggle' });
    const checkbox = availToggle.createEl('input', { type: 'checkbox' });
    checkbox.checked = this.showAvailableOnly;
    availToggle.createSpan({ text: ' Available only (has auth configured)' });
    checkbox.addEventListener('change', () => { this.showAvailableOnly = checkbox.checked; this.renderList(); });

    const providers = [...new Set(this.allModels.map((m) => m.provider))].sort();
    const providerDropdown = new DropdownComponent(filters).addOption('', 'All providers');
    for (const p of providers) providerDropdown.addOption(p, p);
    providerDropdown
      .setValue(this.providerFilter)
      .onChange((value) => { this.providerFilter = value; this.renderList(); });

    new DropdownComponent(filters)
      .addOption('any', 'Any capability')
      .addOption('reasoning', 'Reasoning / thinking')
      .addOption('image', 'Image input')
      .setValue(this.capabilityFilter)
      .onChange((value) => { this.capabilityFilter = value as typeof this.capabilityFilter; this.renderList(); });

    this.listEl = contentEl.createDiv({ cls: 'pi-model-list' });
    this.renderList();
  }

  private renderList(): void {
    this.listEl.empty();
    const source = this.showAvailableOnly ? this.availableModels : this.allModels;
    const filtered = source.filter((m) => {
      if (this.providerFilter && m.provider !== this.providerFilter) return false;
      if (this.capabilityFilter === 'reasoning' && !m.reasoning) return false;
      if (this.capabilityFilter === 'image' && !m.input.includes('image')) return false;
      return true;
    });

    if (filtered.length === 0) {
      this.listEl.createDiv({ cls: 'pi-empty-state', text: 'No models match the current filters.' });
      return;
    }

    for (const model of filtered) {
      const row = this.listEl.createDiv({ cls: 'pi-model-row' });
      const info = row.createDiv({ cls: 'pi-model-info' });
      info.createSpan({ cls: 'pi-model-name', text: `${model.name}` });
      info.createSpan({ cls: 'pi-model-meta', text: ` (${model.provider}/${model.id}) · ${(model.contextWindow / 1000).toFixed(0)}k ctx${model.reasoning ? ' · reasoning' : ''}` });
      const setBtn = row.createEl('button', { cls: 'pi-chat-btn', text: 'Set as default' });
      setBtn.addEventListener('click', () => void this.handleSetDefault(model));
    }
  }

  private async handleSetDefault(model: BridgeModel): Promise<void> {
    if (!this.bridge) return;
    try {
      await this.bridge.applySettingsOverrides({ defaultProvider: model.provider, defaultModel: model.id });
      await this.bridge.flushSettings();
      new Notice(`Default model set to ${model.name}. Takes effect on the next new pi session/RPC connection.`, 4000);
    } catch (err) {
      new Notice(`Failed to set default model: ${err instanceof Error ? err.message : String(err)}`, 6000);
    }
  }
}

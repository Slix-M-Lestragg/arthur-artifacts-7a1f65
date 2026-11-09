import { App, FuzzySuggestModal, FuzzyMatch } from 'obsidian';
import type ObsidianPiPlugin from '../main';
import type { PiInstanceConfig } from '../types';
import { instanceWorkingDir } from '../instance/InstancePaths';

/**
 * Fuzzy picker for pi terminal instances.
 *
 * Shows each configured instance's name with its effective cwd as a detail
 * note, then opens that instance's terminal leaf.
 */
export class InstancePickerModal extends FuzzySuggestModal<PiInstanceConfig> {
  constructor(
    app: App,
    private readonly plugin: ObsidianPiPlugin,
    private readonly onChoose: (instanceId: string) => void,
    private readonly placeholder?: string,
    private readonly filter?: (cfg: PiInstanceConfig) => boolean,
  ) {
    super(app);
    this.setPlaceholder(placeholder ?? 'Open pi terminal for instance…');
  }

  getItems(): PiInstanceConfig[] {
    const items = this.plugin.settings.instances;
    return this.filter ? items.filter(this.filter) : items;
  }

  getItemText(item: PiInstanceConfig): string {
    return item.name;
  }

  renderSuggestion(item: FuzzyMatch<PiInstanceConfig>, el: HTMLElement): void {
    const cfg = item.item;
    el.createEl('div', { text: cfg.name });
    el.createEl('small', {
      text: cfg.cwd || instanceWorkingDir(this.plugin, cfg),
      cls: 'suggestion-note',
    });
  }

  onChooseItem(item: PiInstanceConfig): void {
    this.onChoose(item.id);
  }
}

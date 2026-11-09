/**
 * Minimal runtime stub for the 'obsidian' package so vitest can resolve modules
 * that import from it. Test files override individual exports via vi.mock().
 */

export class App {
  workspace = new Workspace();
}

export class TFile {
  path = '';
  extension = '';
  name = '';
}

export class TFolder {
  path = '';
  children: (TFile | TFolder)[] = [];
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl!: HTMLElement;
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
  display(): void {}
  hide(): void {}
}

export class Notice {
  constructor(_message: string | DocumentFragment, _duration?: number) {}
  hide(): void {}
}

/** Minimal stub so modules that `extends FuzzySuggestModal` at module-load time
 *  (e.g. CommandPickerModal, InstancePickerModal) can be imported in tests. */
export class FuzzySuggestModal<T = unknown> {
  constructor(_app?: unknown) {}
  open(): void {}
  close(): void {}
  setPlaceholder(_s: string): void {}
  setInstructions(_i: unknown[]): void {}
  getItems(): T[] { return []; }
  getItemText(_item: T): string { return ''; }
  onChooseItem(_item: T, _evt?: unknown): void {}
}

export class Modal {
  titleEl = { setText(_s: string): void {} };
  contentEl = {
    createEl(_tag: string, _attrs?: Record<string, unknown>): HTMLElement {
      return document.createElement('div');
    },
    empty(): void {},
  };
  constructor(_app?: unknown) {}
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export class Setting {
  private parent: unknown;

  constructor(parent?: unknown) {
    this.parent = parent;
  }

  setName(_name: string): this {
    return this;
  }

  setDesc(_desc: string): this {
    return this;
  }

  setDisabled(_disabled: boolean): this {
    return this;
  }

  addText(cb: (text: TextComponent) => void): this {
    const doc = (globalThis as unknown as { document?: Document }).document;
    const inputEl = (doc?.createElement('input') ?? { addEventListener: () => {} }) as HTMLInputElement;
    // Make the input discoverable in tests by appending it to the parent.
    const p = this.parent as { children?: unknown[] };
    if (p?.children) {
      p.children.push(inputEl as unknown);
    }
    const comp: TextComponent = {
      inputEl,
      setValue(value: string | number) {
        inputEl.value = String(value);
        return this;
      },
      setPlaceholder(placeholder: string) {
        inputEl.setAttribute?.('placeholder', placeholder);
        return this;
      },
      onChange(callback: (value: string) => void) {
        inputEl.addEventListener('change', () => callback(inputEl.value));
        return this;
      },
    } as unknown as TextComponent;
    cb(comp);
    return this;
  }

  addDropdown(cb: (dropdown: DropdownComponent) => void): this {
    cb({
      addOption() { return this; },
      setValue() { return this; },
      onChange() { return this; },
    } as unknown as DropdownComponent);
    return this;
  }

  addToggle(cb: (toggle: ToggleComponent) => void): this {
    cb({
      setValue() { return this; },
      onChange() { return this; },
    } as unknown as ToggleComponent);
    return this;
  }

  addButton(cb: (b: ButtonComponent) => void): this {
    cb({
      setButtonText(_s: string) { return this; },
      setCta() { return this; },
      setWarning() { return this; },
      onClick(_fn: () => void) { return this; },
    } as unknown as ButtonComponent);
    return this;
  }
}

export interface ButtonComponent {
  setButtonText(text: string): this;
  setCta(): this;
  setWarning(): this;
  onClick(callback: () => void): this;
}

export interface TextComponent {
  inputEl: HTMLInputElement;
  setValue(value: string | number): this;
  setPlaceholder(placeholder: string): this;
  onChange(callback: (value: string) => void): this;
}

export interface DropdownComponent {
  addOption(value: string, label: string): this;
  setValue(value: string): this;
  onChange(callback: (value: string) => void): this;
}

export interface ToggleComponent {
  setValue(value: boolean): this;
  onChange(callback: (value: boolean) => void): this;
}

/** Minimal fake WorkspaceLeaf so views can be constructed in node tests. */
export class WorkspaceLeaf {
  view?: unknown;
  async openFile(_file: TFile, _state?: unknown): Promise<void> {}
  getViewState(): unknown {
    return {};
  }
  async setViewState(_state: unknown): Promise<void> {}
  detach(): void {}
  getContainer(): unknown {
    return {};
  }
}

/** Minimal fake ItemView base class for FarmView tests. */
export class ItemView {
  leaf: WorkspaceLeaf;
  app: App;
  private _contentEl?: HTMLElement;

  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
    this.app = (globalThis as unknown as { app?: App }).app ?? new App();
  }

  get contentEl(): HTMLElement {
    if (!this._contentEl) {
      this._contentEl = (globalThis as unknown as { document: Document }).document.createElement('div');
    }
    return this._contentEl;
  }

  getViewType(): string {
    return '';
  }

  getDisplayText(): string {
    return '';
  }

  async onOpen(): Promise<void> {}

  async onClose(): Promise<void> {}

  registerEvent(_ref: unknown): void {}
}

/** Minimal fake Workspace with event registration/triggering. */
export class Workspace {
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  getLeavesOfType() {
    return [];
  }
  iterateAllLeaves() {}
  getRightLeaf() {
    return null;
  }
  getLeaf() {
    return null;
  }
  openPopoutLeaf(_options?: { size?: { width: number; height: number } }): WorkspaceLeaf {
    return new WorkspaceLeaf();
  }
  revealLeaf() {}
  onLayoutReady(cb: () => void): void {
    cb();
  }
  on(event: string, handler: (...args: unknown[]) => void): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    };
  }
  trigger(event: string, ...args: unknown[]): void {
    const list = this.handlers.get(event);
    if (!list) return;
    for (const h of [...list]) h(...args);
  }
}

export function setIcon(el: HTMLElement, icon: string): void {
  if ('empty' in el && typeof (el as { empty?: () => void }).empty === 'function') {
    (el as { empty: () => void }).empty();
  }
  const wrapper = el as unknown as { createEl?: (tag: string, attrs?: { cls?: string }) => HTMLElement };
  if (wrapper.createEl) {
    wrapper.createEl('svg', { cls: `lucide-${icon}` });
  }
}

export function setTooltip(el: HTMLElement, text: string, _options?: { delay?: number; placement?: string }): void {
  (el as unknown as { title?: string }).title = text;
}

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isMacOS: true,
  isWindows: false,
  isLinux: false,
  isIOS: false,
  isAndroid: false,
};

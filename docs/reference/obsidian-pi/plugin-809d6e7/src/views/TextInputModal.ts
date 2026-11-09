/**
 * TextInputModal — small text-input modal + `promptForText()` helper.
 *
 * Extracted from the deleted ChatView-era SessionPanel (the only part of that
 * module still in use). Returns null on cancel / empty input.
 */

import { App, Modal } from 'obsidian';

export class TextInputModal extends Modal {
  private input!: HTMLInputElement;
  private resolveFn: (value: string | null) => void;
  private settled = false;

  constructor(app: App, title: string, private placeholder?: string, private initialValue?: string) {
    super(app);
    this.titleEl.setText(title);
    this.resolveFn = () => {};
  }

  onOpen(): void {
    this.input = this.contentEl.createEl('input', { type: 'text' });
    this.input.placeholder = this.placeholder ?? '';
    this.input.value = this.initialValue ?? '';
    this.input.style.cssText =
      'width: 100%; padding: 8px; margin: 8px 0; border-radius: 6px; ' +
      'border: 1px solid var(--background-modifier-border); ' +
      'background: var(--background-primary); color: var(--text-normal);';
    const ok = this.contentEl.createEl('button', { text: 'OK', cls: 'mod-cta' });
    ok.style.marginLeft = '8px';
    ok.addEventListener('click', () => {
      this.settled = true;
      this.resolveFn(this.input.value.trim() || null);
      this.close();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.settled = true;
        this.resolveFn(this.input.value.trim() || null);
        this.close();
      }
      if (e.key === 'Escape') { this.close(); }
    });
    this.input.addEventListener('focus', () => this.input.select());
    setTimeout(() => {
      this.input.focus();
      this.input.select();
    }, 50);
  }

  onClose(): void { if (!this.settled) this.resolveFn(null); }

  static prompt(app: App, title: string, placeholder?: string, initialValue?: string): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new TextInputModal(app, title, placeholder, initialValue);
      modal.resolveFn = resolve;
      modal.open();
    });
  }
}

export function promptForText(title: string, app: App): Promise<string | null> {
  return TextInputModal.prompt(app, title);
}
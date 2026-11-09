/**
 * HeadlessResultModal — shows the result of a one-shot pi JSON run.
 *
 * Features:
 *   • Editable result text — user can modify before applying
 *   • Rerun button — re-runs the same prompt with a variation seed
 *   • Prompt preview — collapsible, shows what was sent to pi
 *   • Apply options: write below codeblock, append, replace, new note, copy
 *
 * For codeblock triggers, "Write below codeblock" inserts a `pi-result` block
 * under the source codeblock (idempotent — replaces if existing).
 */

import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import type { VaultContext } from '../vault/VaultContext';

export class HeadlessResultModal extends Modal {
  private textarea!: HTMLTextAreaElement;

  constructor(
    app: App,
    private readonly result: { text: string; exitCode: number | null; stderr: string; error?: string },
    private readonly vaultContext: VaultContext,
    private readonly sourceFile: TFile | null,
    private readonly sourceLineStart?: number,
    private readonly promptPreview?: string,
    private readonly rerun?: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('pi-headless-modal');

    // ── Header ────────────────────────────────────────────────────────────
    if (this.result.error) {
      contentEl.createEl('h3', { text: '❌ pi run failed' });
      contentEl.createEl('p', { text: this.result.error, cls: 'pi-headless-error' });
    } else if (this.result.exitCode !== 0) {
      contentEl.createEl('h3', { text: '⚠️ pi exited with errors' });
    } else {
      contentEl.createEl('h3', { text: '✓ pi completed' });
    }

    // ── Prompt preview (collapsible) ──────────────────────────────────────
    if (this.promptPreview) {
      const details = contentEl.createEl('details', { cls: 'pi-prompt-preview' });
      details.createEl('summary', { text: '📋 Prompt sent' });
      const pre = details.createEl('pre');
      pre.setText(this.promptPreview);
      pre.style.cssText =
        'max-height: 150px; overflow-y: auto; white-space: pre-wrap; word-wrap: break-word; ' +
        'padding: 8px; font-size: 0.8em; color: var(--text-muted); ' +
        'background: var(--background-secondary); border-radius: 4px; ' +
        'user-select: text; cursor: text;';
    }

    // ── Editable result text ──────────────────────────────────────────────
    if (this.result.text) {
      contentEl.createEl('p', {
        text: 'Edit the result below before applying if needed:',
        cls: 'pi-headless-edit-hint',
      });
      this.textarea = contentEl.createEl('textarea', { cls: 'pi-headless-textarea' });
      this.textarea.value = this.result.text;
      this.textarea.style.cssText =
        'width: 100%; min-height: 200px; max-height: 500px; resize: vertical; ' +
        'padding: 12px; border-radius: 6px; border: 1px solid var(--background-modifier-border); ' +
        'background: var(--background-primary); color: var(--text-normal); ' +
        'font-family: var(--font-monospace); font-size: 0.9em; line-height: 1.4; ' +
        'white-space: pre-wrap; word-wrap: break-word;';
    } else if (!this.result.error) {
      contentEl.createEl('p', { text: '(no output)', cls: 'pi-headless-empty' });
    }

    // ── Stderr (collapsible, for debugging) ───────────────────────────────
    if (this.result.stderr) {
      const details = contentEl.createEl('details');
      details.createEl('summary', { text: 'stderr' });
      const pre = details.createEl('pre');
      pre.setText(this.result.stderr.slice(-2000));
      pre.style.cssText =
        'max-height: 200px; overflow-y: auto; white-space: pre-wrap; ' +
        'padding: 8px; font-size: 0.8em; color: var(--text-muted); ' +
        'background: var(--background-secondary); border-radius: 4px; ' +
        'user-select: text; cursor: text;';
    }

    // ── Action buttons ────────────────────────────────────────────────────
    if (this.result.text || this.rerun) {
      contentEl.createEl('hr');

      // Rerun button — re-runs the same prompt with a variation seed.
      if (this.rerun) {
        const rerunBtn = contentEl.createEl('button', { text: '↻ Rerun', cls: 'pi-headless-rerun' });
        rerunBtn.style.cssText =
          'padding: 6px 14px; border-radius: 6px; border: 1px solid var(--background-modifier-border); ' +
          'background: var(--background-secondary); color: var(--text-normal); ' +
          'cursor: pointer; margin-right: 8px;';
        rerunBtn.addEventListener('click', async () => {
          this.close();
          await this.rerun!();
        });
      }

      if (this.result.text) {
        const applyRow = contentEl.createDiv({ cls: 'pi-headless-apply-row' });

        // Write below codeblock (if triggered from a codeblock).
        if (this.sourceFile && this.sourceLineStart != null) {
          const writeBtn = applyRow.createEl('button', { cls: 'mod-cta', text: 'Write below codeblock' });
          writeBtn.addEventListener('click', async () => {
            await this.writeBelowCodeblock(this.textarea.value);
            this.close();
          });
        }

        // Append to note.
        const appendBtn = applyRow.createEl('button', { text: 'Append to note' });
        appendBtn.addEventListener('click', async () => {
          await this.vaultContext.appendToNote(this.textarea.value, this.sourceFile ?? undefined);
          this.close();
        });

        // Replace selection.
        const replaceBtn = applyRow.createEl('button', { text: 'Replace selection' });
        replaceBtn.addEventListener('click', async () => {
          await this.vaultContext.replaceSelection(this.textarea.value, this.sourceFile ?? undefined);
          this.close();
        });

        // New note.
        const newBtn = applyRow.createEl('button', { text: 'New note' });
        newBtn.addEventListener('click', async () => {
          await this.vaultContext.createNewNote(this.textarea.value);
          this.close();
        });

        // Copy to clipboard.
        const copyBtn = applyRow.createEl('button', { text: 'Copy' });
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(this.textarea.value);
          new Notice('Copied to clipboard', 2000);
        });
      }
    }

    // Close button.
    new Setting(contentEl).addButton((b) =>
      b.setButtonText('Close').onClick(() => this.close()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /**
   * Write a `pi-result` codeblock below the source codeblock.
   * If a `pi-result` block already exists below, replace it (idempotent).
   */
  private async writeBelowCodeblock(text: string): Promise<void> {
    const file = this.sourceFile;
    if (!file || this.sourceLineStart == null) return;

    const content = await this.app.vault.read(file);
    const lines = content.split('\n');

    // Find the end of the source codeblock (the closing ``` line).
    let codeblockEnd = this.sourceLineStart;
    let inBlock = false;
    for (let i = this.sourceLineStart; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith('```pi') && !inBlock) {
        inBlock = true;
        continue;
      }
      if (lines[i].trim() === '```' && inBlock) {
        codeblockEnd = i;
        break;
      }
    }

    // Check if a pi-result block already exists right after.
    let resultStart = -1;
    let resultEnd = -1;
    for (let i = codeblockEnd + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('```pi-result')) {
        resultStart = i;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '```') {
            resultEnd = j;
            break;
          }
        }
        break;
      }
      if (trimmed !== '' && !trimmed.startsWith('```')) {
        break;
      }
    }

    const resultBlock = ['```pi-result', text, '```'];

    let newLines: string[];
    if (resultStart >= 0 && resultEnd >= 0) {
      newLines = [
        ...lines.slice(0, resultStart),
        ...resultBlock,
        ...lines.slice(resultEnd + 1),
      ];
    } else {
      newLines = [
        ...lines.slice(0, codeblockEnd + 1),
        '',
        ...resultBlock,
        ...lines.slice(codeblockEnd + 1),
      ];
    }

    await this.app.vault.modify(file, newLines.join('\n'));
    new Notice('Result written below codeblock', 2000);
  }
}
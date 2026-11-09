/**
 * DispatchResultModal — shows the streamed result of a swarm dispatch
 * (dispatchTaskToWorker). A simple read-only modal with a Copy button; short
 * successful results are surfaced as a Notice instead via showDispatchResult.
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import type { DispatchResult } from '../transport/swarmDispatch';

export class DispatchResultModal extends Modal {
  constructor(
    app: App,
    private readonly result: DispatchResult,
    private readonly task: string,
    private readonly pool: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('pi-dispatch-result-modal');

    if (this.result.error) {
      contentEl.createEl('h3', { text: '❌ Dispatch failed' });
      contentEl.createEl('p', { text: this.result.error, cls: 'pi-headless-error' });
    } else if (this.result.timedOut) {
      contentEl.createEl('h3', { text: '⏱ Dispatch timed out' });
    } else if (this.result.exitCode !== 0) {
      contentEl.createEl('h3', { text: '⚠️ Worker exited with errors' });
    } else {
      contentEl.createEl('h3', { text: '✓ Worker completed' });
    }

    contentEl.createEl('p', {
      text: `pool: ${this.pool} · terminal: ${this.result.terminalUri || '—'}`,
      cls: 'pi-dispatch-meta',
    });

    if (this.result.text) {
      const pre = contentEl.createEl('pre', { cls: 'pi-dispatch-result' });
      pre.setText(this.result.text);
      pre.style.cssText =
        'max-height: 400px; overflow-y: auto; white-space: pre-wrap; word-wrap: break-word; ' +
        'padding: 12px; border-radius: 6px; border: 1px solid var(--background-modifier-border); ' +
        'background: var(--background-primary); color: var(--text-normal); ' +
        'font-family: var(--font-monospace); font-size: 0.9em; line-height: 1.4; ' +
        'user-select: text; cursor: text;';
    } else if (!this.result.error) {
      contentEl.createEl('p', { text: '(no output)', cls: 'pi-headless-empty' });
    }

    if (this.result.exitCode != null) {
      contentEl.createEl('p', {
        text: `exit code: ${this.result.exitCode}`,
        cls: 'pi-dispatch-exit',
      });
    }

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText('Copy').onClick(() => {
          void navigator.clipboard.writeText(this.result.text);
          new Notice('Copied to clipboard', 2000);
        }),
      )
      .addButton((b) => b.setButtonText('Close').onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Surface a dispatch result: short successful results as a Notice, everything
 * else (long results, errors, timeouts) in the DispatchResultModal.
 */
export function showDispatchResult(
  app: App,
  result: DispatchResult,
  task: string,
  pool: string,
): void {
  const short = !result.error && !result.timedOut && result.text.length > 0 && result.text.length <= 200;
  if (short) {
    new Notice(`✓ ${pool}: ${result.text}`, 8000);
    return;
  }
  new DispatchResultModal(app, result, task, pool).open();
}

/**
 * CommandSuggester — inline `/command` autocomplete for the chat input.
 *
 * When the user types `/` at the start of the input or after a newline, a floating
 * list of available pi commands (extensions, prompts, skills) appears.  The list is
 * fetched once via `get_commands()` and cached for the session.  Prefix-first
 * alphabetical sorting, same as WikilinkSuggester.
 *
 * Arrow keys navigate, Enter / Tab selects, Escape dismisses.
 */

import type { PiClient } from '../transport/RpcClient';
import type { RpcSlashCommand } from '../types/rpc';

interface CommandItem {
  name: string;
  description: string;
  source: string;
}

export class CommandSuggester {
  private popup: HTMLElement | null = null;
  private allCommands: CommandItem[] = [];
  private filteredItems: CommandItem[] = [];
  private selectedIndex = 0;
  private active = false;
  private fetched = false;
  private fetching = false;

  constructor(
    private textarea: HTMLTextAreaElement,
    private getRpcClient: () => PiClient | null,
  ) {
    textarea.addEventListener('input', () => this.onInput());
    textarea.addEventListener('keydown', (e) => this.onKeydown(e));
    textarea.addEventListener('blur', () => setTimeout(() => this.hide(), 150));
  }

  /** Whether the suggester is currently showing a popup. */
  get isActive(): boolean { return this.active; }

  // ─── Detection ─────────────────────────────────────────────────────────────

  /** Match `/command-query` at the start of input or after a newline. */
  private getOpenCommand(): string | null {
    const pos = this.textarea.selectionStart;
    const before = this.textarea.value.substring(0, pos);
    const match = before.match(/(?:^|\n)\/([a-zA-Z0-9_:-]*)$/);
    return match ? match[1] : null;
  }

  private async onInput(): Promise<void> {
    const query = this.getOpenCommand();
    if (query !== null) {
      await this.ensureCommands();
      this.showSuggestions(query);
    } else {
      this.hide();
    }
  }

  /** Lazy-fetch commands once and cache. */
  private async ensureCommands(): Promise<void> {
    if (this.fetched || this.fetching) return;
    this.fetching = true;
    try {
      const client = this.getRpcClient();
      if (!client) { this.allCommands = []; this.fetched = true; return; }
      const commands = await client.getCommands();
      this.allCommands = commands.map((c) => ({
        name: c.name,
        description: c.description ?? '',
        source: c.source,
      }));
      this.fetched = true;
    } catch {
      this.allCommands = [];
      this.fetched = true;
    } finally {
      this.fetching = false;
    }
  }

  // ─── Suggestions ───────────────────────────────────────────────────────────

  private showSuggestions(query: string): void {
    if (!this.fetched || this.allCommands.length === 0) return;

    const q = query.toLowerCase();
    const prefix: CommandItem[] = [];
    const substring: CommandItem[] = [];

    for (const cmd of this.allCommands) {
      const name = cmd.name.toLowerCase();
      if (q && name.startsWith(q)) {
        prefix.push(cmd);
      } else if (!q || name.includes(q)) {
        substring.push(cmd);
      }
    }

    prefix.sort((a, b) => a.name.localeCompare(b.name));
    substring.sort((a, b) => a.name.localeCompare(b.name));

    this.filteredItems = [...prefix, ...substring].slice(0, 12);
    if (this.filteredItems.length === 0) {
      this.hide();
      return;
    }

    this.selectedIndex = 0;
    this.active = true;
    this.render();
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  private render(): void {
    if (!this.popup) {
      this.popup = document.createElement('div');
      this.popup.className = 'pi-wikilink-suggest pi-command-suggest';
      document.body.appendChild(this.popup);
    }
    const popup = this.popup;
    popup.empty();

    this.filteredItems.forEach((item, i) => {
      const div = popup.createDiv({
        cls: 'pi-wikilink-item pi-command-item' + (i === this.selectedIndex ? ' is-selected' : ''),
      });
      // Source badge
      const badge = div.createSpan({ cls: 'pi-command-source', text: item.source });
      // Command name
      div.createSpan({ cls: 'pi-command-name', text: item.name });
      // Description
      if (item.description) {
        div.createSpan({ cls: 'pi-command-desc', text: ` — ${item.description}` });
      }
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.select(i);
      });
    });

    const rect = this.textarea.getBoundingClientRect();
    this.popup.style.cssText = `position: fixed; top: ${rect.bottom + 4}px; left: ${rect.left}px; min-width: ${rect.width}px; display: block;`;
  }

  // ─── Keyboard ──────────────────────────────────────────────────────────────

  private onKeydown(e: KeyboardEvent): void {
    if (!this.active) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.selectedIndex = (this.selectedIndex + 1) % this.filteredItems.length;
      this.updateSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.selectedIndex = (this.selectedIndex - 1 + this.filteredItems.length) % this.filteredItems.length;
      this.updateSelection();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (this.getOpenCommand() !== null) {
        e.preventDefault();
        this.select(this.selectedIndex);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.hide();
    }
  }

  private updateSelection(): void {
    if (!this.popup) return;
    this.popup.querySelectorAll('.pi-command-item').forEach((el, i) => {
      el.toggleClass('is-selected', i === this.selectedIndex);
    });
  }

  // ─── Insert ────────────────────────────────────────────────────────────────

  private select(index: number): void {
    const item = this.filteredItems[index];
    if (!item) return;

    const pos = this.textarea.selectionStart;
    const before = this.textarea.value.substring(0, pos);
    const after = this.textarea.value.substring(pos);

    // Find the last / that's at the start of input or after a newline.
    const slashIdx = before.lastIndexOf('/');
    if (slashIdx === -1) return;
    // Validate it's at start or after newline (consistent with getOpenCommand).
    if (slashIdx > 0 && before[slashIdx - 1] !== '\n') return;

    const replaced = before.substring(0, slashIdx) + `/${item.name}`;
    this.textarea.value = replaced + after;
    const newPos = replaced.length;
    this.textarea.setSelectionRange(newPos, newPos);
    this.textarea.focus();
    this.hide();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  hide(): void {
    this.active = false;
    if (this.popup) this.popup.style.display = 'none';
  }

  destroy(): void {
    this.popup?.remove();
    this.popup = null;
    this.active = false;
  }
}
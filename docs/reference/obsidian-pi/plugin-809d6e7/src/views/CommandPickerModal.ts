/**
 * CommandPickerModal — searchable list of pi slash commands.
 *
 * Fetches available commands via `rpcClient.get_commands()` and lets the
 * user pick one to insert into the chat input. Covers Phase 4-commands.
 *
 * Commands are pre-fetched before the modal opens so the list is populated
 * immediately (FuzzySuggestModal doesn't re-render on async data arrival).
 */

import { App, FuzzySuggestModal, Notice } from 'obsidian';
import type { PiClient } from '../transport/RpcClient';
import type { RpcSlashCommand } from '../types/rpc';

export class CommandPickerModal extends FuzzySuggestModal<RpcSlashCommand> {
  private readonly onPick: (commandText: string) => void;
  private commands: RpcSlashCommand[] = [];

  constructor(app: App, commands: RpcSlashCommand[], onPick: (commandText: string) => void) {
    super(app);
    this.commands = commands;
    this.onPick = onPick;
    this.setPlaceholder('Search pi commands (extensions, prompts, skills)…');
    this.setInstructions([
      { command: '↑↓', purpose: 'navigate' },
      { command: '↵', purpose: 'insert command into chat' },
      { command: 'esc', purpose: 'dismiss' },
    ]);
  }

  getItems(): RpcSlashCommand[] {
    return this.commands;
  }

  getItemText(item: RpcSlashCommand): string {
    const desc = item.description ? ` — ${item.description}` : '';
    return `${item.name}${desc}`;
  }

  onChooseItem(item: RpcSlashCommand): void {
    // Commands are invoked by prefixing with /
    const commandText = `/${item.name}`;
    this.onPick(commandText);
  }
}

/**
 * Open the command picker after pre-fetching the command list.
 * Shows a Notice on failure.
 */
export async function openCommandPicker(
  app: App,
  client: PiClient,
  onPick: (commandText: string) => void,
): Promise<void> {
  let commands: RpcSlashCommand[] = [];
  try {
    commands = await client.getCommands();
  } catch (err) {
    new Notice(`Failed to load commands: ${err instanceof Error ? err.message : String(err)}`, 5000);
    return;
  }
  if (commands.length === 0) {
    new Notice('No pi commands available', 3000);
    return;
  }
  new CommandPickerModal(app, commands, onPick).open();
}
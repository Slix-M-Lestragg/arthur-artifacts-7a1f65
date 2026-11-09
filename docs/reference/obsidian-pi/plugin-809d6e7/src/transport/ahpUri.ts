/**
 * URI helpers for AHP channels.
 */

/** Derive the read-only terminal mirror URI for a subagent child chat. */
export function deriveAhpTerminalUriFromChat(chatUri: string): string {
  return chatUri.replace(/^ahp-chat:/, 'ahp-terminal:');
}

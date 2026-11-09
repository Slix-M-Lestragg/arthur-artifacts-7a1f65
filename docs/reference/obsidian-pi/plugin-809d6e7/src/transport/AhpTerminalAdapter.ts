/**
 * AhpTerminalAdapter — render a remote AHP session into an xterm.js Terminal.
 *
 * Supports two additive modes:
 *   • chat mode (default): line-buffered input → client.prompt(), renders the
 *     RpcEvent stream from AhpActionMapper.
 *   • terminal mode (terminalUri set): raw keystrokes → terminal/input,
 *     server-authoritative terminal/data output, true interactive PTY.
 */

import type { Terminal } from '@xterm/xterm';
import type { AhpTerminalApi, ActionEnvelope, URI } from './AhpClient';
import { APC_PREFIX, APC_PAYLOAD, APC_TERM, APC_ANSWER_PREFIX } from './apc';

/** Live tab-icon state for an AHP terminal (mirrors PiTerminalIconState). */
export type AhpTerminalIconState = 'idle' | 'running' | 'done-unseen' | 'seen' | 'awaiting-input' | 'error';
import type { RpcEvent, AssistantMessageDelta } from '../types/rpc';

// Minimal ANSI SGR codes (xterm.js interprets these regardless of theme).
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

const NL = '\r\n';

export interface AhpTerminalAdapterOptions {
  /** When set, the adapter runs in interactive terminal (PTY) mode. */
  terminalUri?: URI;
  /** Source of truth for the remote PTY size. When `external`, the real terminal
   *  is driven by a physical desktop elsewhere; the Obsidian viewer must NOT
   *  fight it by requesting resizes. For `server-spawned` (or undefined/legacy)
   *  the viewer is the sole authority and keeps requesting resizes as today. */
  terminalMode?: 'external' | 'server-spawned' | 'none';
  /** When true, the adapter renders a read-only mirror: it still displays
   *  terminal/data but does not forward keystrokes via terminal/input. */
  readOnly?: boolean;
}

export class AhpTerminalAdapter {
  private readonly term: Terminal;
  private readonly client: AhpTerminalApi;
  private readonly mode: 'chat' | 'terminal';
  private readonly terminalUri?: URI;
  private unsub: (() => void) | null = null;
  private terminalActionUnsub: (() => void) | null = null;
  private onDataDispose: (() => void) | null = null;

  /** Line buffer for terminal input (a mini line editor — xterm doesn't echo). */
  private inputBuffer = '';
  /** True while the assistant's response text is on the current line (no NL yet). */
  private inAssistantLine = false;
  /** True for the turn we just dispatched locally — suppresses the "You:" echo. */
  private pendingLocalTurn = false;

  private readonly terminalMode?: 'external' | 'server-spawned' | 'none';
  private readonly readOnly: boolean;

  constructor(
    term: Terminal,
    client: AhpTerminalApi,
    private readonly onState?: (state: AhpTerminalIconState) => void,
    opts?: AhpTerminalAdapterOptions,
  ) {
    this.term = term;
    this.client = client;
    this.terminalUri = opts?.terminalUri;
    this.terminalMode = opts?.terminalMode;
    this.readOnly = opts?.readOnly ?? false;
    this.mode = this.terminalUri ? 'terminal' : 'chat';
  }

  /** Subscribe to the client event stream + terminal input. Idempotent. */
  attach(): void {
    if (this.unsub) return;
    this.unsub = this.client.onEvent((ev) => this.renderEvent(ev));
    if (this.mode === 'terminal') {
      if (this.readOnly) {
        this.write(
          `${DIM}Read-only mirror of subagent terminal: ${String(this.terminalUri)}. Keystrokes are ignored.${RESET}${NL}${NL}`,
        );
      } else {
        this.write(
          `${DIM}Connected to interactive terminal: ${String(this.terminalUri)}. Keystrokes are sent live to the remote PTY.${RESET}${NL}${NL}`,
        );
        const dispose = this.term.onData((d) => this.handleInput(d));
        this.onDataDispose = () => dispose.dispose();
      }
      this.terminalActionUnsub = this.client.onNotification('action', (params) => {
        const envelope = params as unknown as ActionEnvelope;
        if (envelope.channel !== this.terminalUri) return;
        // The server echoes every dispatched action back to the originating
        // client. Re-applying our own terminal/resized action would call
        // term.resize(), which fires xterm.js's onResize handler and dispatches
        // a new resize, creating an infinite flicker loop. Other self-echoed
        // actions are either not handled here (terminal/input) or never
        // originate from this viewer, so dropping all self-echoed actions on
        // this channel is safe and defensive.
        if (envelope.origin?.clientId === this.client.clientId) return;
        this.handleTerminalAction(envelope.action);
      });
    } else {
      this.write(
        `${DIM}Connected to remote AHP session. Type a message + Enter to send.${RESET}${NL}${NL}`,
      );
      const dispose = this.term.onData((d) => this.handleInput(d));
      this.onDataDispose = () => dispose.dispose();
    }
  }

  detach(): void {
    this.unsub?.();
    this.unsub = null;
    this.terminalActionUnsub?.();
    this.terminalActionUnsub = null;
    this.onDataDispose?.();
    this.onDataDispose = null;
  }

  /** Best-effort resize notification. No-op in chat mode or when the real PTY
   *  is externally supervised (the physical terminal on the remote desktop owns
   *  the size authority). */
  resize(cols: number, rows: number): void {
    if (this.mode !== 'terminal' || !this.terminalUri) return;
    this.client.resizeTerminal(this.terminalUri, cols, rows);
  }

  // ─── Prompt editor / config button bridge ──────────────────────────────────
  // These mirror PtyClient.submitPrompt / write so the PromptPopout + toolbar
  // config buttons (Session/Model/Settings/Compact) work on AHP remote terminals
  // exactly like local ones — the remote pi has the same obsidian-bridge stub.

  /** Submit a prompt via the APC marker (same protocol as PtyClient.submitPrompt).
   *  The remote pi's obsidian-bridge recognizes the marker + submits the text. */
  submitPrompt(text: string): void {
    if (this.mode !== 'terminal' || !this.terminalUri || this.readOnly) return;
    // UTF-8 safe base64: btoa alone fails on Unicode (accented chars, emojis).
    const b64 = btoa(unescape(encodeURIComponent(text)));
    this.client.sendTerminalInput(this.terminalUri, APC_PREFIX + APC_PAYLOAD + b64 + APC_TERM);
  }

  /** Send a raw byte sequence (slash command + \r, or an escape sequence) to
   *  the remote PTY. Used by the toolbar config buttons (sendSlashCommand/sendRaw). */
  sendRaw(data: string): void {
    if (this.mode !== 'terminal' || !this.terminalUri || this.readOnly) return;
    this.client.sendTerminalInput(this.terminalUri, data);
  }

  /** Answer an in-flight question_user tool call (terminal mode). Writes the
   *  pi:answer:<questionId>:<base64({answer,wasCustom})> APC marker to the remote
   *  PTY — the obsidian-bridge intercepts it + feeds the answer to the tool. */
  sendQuestionAnswer(questionId: string, answer: string, wasCustom: boolean): void {
    if (this.mode !== 'terminal' || !this.terminalUri || this.readOnly) return;
    const json = JSON.stringify({ answer, wasCustom });
    const b64 = btoa(unescape(encodeURIComponent(json)));
    this.client.sendTerminalInput(this.terminalUri, APC_PREFIX + APC_ANSWER_PREFIX + questionId + ':' + b64 + APC_TERM);
  }

  // ─── Input → remote chat or PTY ─────────────────────────────────────────────

  private handleInput(data: string): void {
    if (this.mode === 'terminal') {
      if (!this.terminalUri) return;
      // Block paste: wrap multiline data in bracketed paste sequences so the
      // remote PTY treats it as a single paste block, not individual commands
      // per line. ESC[200~ = paste start, ESC[201~ = paste end.
      let send = data;
      // Only wrap MULTILINE data (2+ newlines = actual paste), NOT a single
      // Enter key (\r) which would be wrapped as a paste and break submit.
      const newlineCount = (data.match(/[\r\n]/g) || []).length;
      if (newlineCount > 1 && !data.startsWith('\x1b[200~')) {
        send = '\x1b[200~' + data + '\x1b[201~';
      }
      try {
        this.client.sendTerminalInput(this.terminalUri, send);
      } catch (err) {
        this.writeLine(`${YELLOW}(terminal send failed: ${err instanceof Error ? err.message : String(err)})${RESET}`);
      }
      return;
    }

    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (ch === '\r' || ch === '\n') {
        const line = this.inputBuffer;
        this.inputBuffer = '';
        this.term.write(NL);
        if (line.trim()) {
          this.pendingLocalTurn = true;
          void this.client.prompt(line).catch((err) => {
            this.writeLine(`${YELLOW}(failed to send: ${err instanceof Error ? err.message : String(err)})${RESET}`);
          });
        }
      } else if (code === 127 || code === 8) {
        // Backspace / Ctrl+H — erase one char from the buffer + screen.
        if (this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this.term.write('\b \b');
        }
      } else if (code >= 32 && !ch.startsWith('\x1b')) {
        // Printable char (skip escape sequences — not part of a prompt line).
        this.inputBuffer += ch;
        this.term.write(ch);
      }
    }
  }

  // ─── Terminal channel actions ───────────────────────────────────────────────

  private handleTerminalAction(action: Record<string, unknown>): void {
    switch (action.type) {
      case 'terminal/data':
        this.term.write(String(action.data ?? ''));
        break;
      case 'terminal/cleared':
        this.term.clear();
        break;
      case 'terminal/titleChanged': {
        const title = String(action.title ?? '');
        this.term.write(`\x1b]0;${title}\x07`);
        break;
      }
      case 'terminal/exited': {
        this.endAssistantLine();
        const code = action.code;
        this.writeLine(`${DIM}«remote terminal exited${code != null ? ` (code ${code})` : ''}»${RESET}`);
        this.onState?.('idle');
        break;
      }
      case 'terminal/claimed':
        this.onState?.('running');
        break;
      case 'terminal/resized': {
        const cols = Number(action.cols);
        const rows = Number(action.rows);
        if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
          this.term.resize(cols, rows);
        }
        break;
      }
      default:
        break;
    }
  }

  // ─── RpcEvent → ANSI transcript ──────────────────────────────────────────────

  private renderEvent(ev: RpcEvent): void {
    if (this.mode === 'terminal') return; // chat events are not interleaved in PTY mode
    switch (ev.type) {
      case 'agent_start':
        this.onState?.('running');
        // message_start carries the prompt + opens the assistant line.
        break;

      case 'message_start': {
        this.endAssistantLine();
        const message = (ev.message ?? {}) as Record<string, unknown>;
        const text = typeof message.text === 'string' ? message.text : '';
        if (this.pendingLocalTurn) {
          // We already echoed the prompt as the user typed it.
          this.pendingLocalTurn = false;
        } else if (text) {
          this.writeLine(`${BOLD}You:${RESET} ${text}`);
        }
        this.write(`${GREEN}pi:${RESET} `);
        this.inAssistantLine = true;
        break;
      }

      case 'message_update': {
        this.writeDelta(ev.assistantMessageEvent);
        break;
      }

      case 'tool_execution_start': {
        this.endAssistantLine();
        const args = (ev.args ?? {}) as Record<string, unknown>;
        const label = (typeof args.displayName === 'string' && args.displayName)
          || ev.toolName || 'tool';
        const intention = typeof args.intention === 'string' ? ` — ${args.intention}` : '';
        this.writeLine(`${CYAN}▸ ${label}${intention}${RESET}`);
        break;
      }

      case 'tool_execution_end': {
        this.endAssistantLine();
        const result = (ev.result ?? {}) as Record<string, unknown>;
        const content = Array.isArray(result.content) ? result.content : [];
        const text = content
          .filter((c): c is { type: string; text: string } => typeof c === 'object' && c !== null && (c as { type?: string }).type === 'text' && typeof (c as { text?: unknown }).text === 'string')
          .map((c) => c.text)
          .join('\n');
        if (text) {
          const prefix = ev.isError ? `${YELLOW}↳ (failed)${RESET} ` : `${DIM}↳${RESET} `;
          this.write(prefix);
          this.writeLine(text.split('\n').map((l) => `${DIM}${l}${RESET}`).join(NL));
        } else if (ev.isError) {
          this.writeLine(`${YELLOW}↳ (tool failed)${RESET}`);
        }
        break;
      }

      case 'message_end':
      case 'turn_end':
        this.endAssistantLine();
        break;

      case 'agent_end':
        this.endAssistantLine();
        this.write(NL); // blank line between turns
        this.onState?.('done-unseen');
        break;

      default:
        // compaction_*, auto_retry_*, queue_update, extension_error — not rendered.
        break;
    }
  }

  private writeDelta(ame: AssistantMessageDelta): void {
    if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
      this.write(ame.delta);
    }
  }

  private endAssistantLine(): void {
    if (this.inAssistantLine) {
      this.term.write(NL);
      this.inAssistantLine = false;
    }
  }

  // ─── low-level writes ────────────────────────────────────────────────────────

  private write(s: string): void {
    this.term.write(s);
  }

  private writeLine(s: string): void {
    this.term.write(s + NL);
  }
}

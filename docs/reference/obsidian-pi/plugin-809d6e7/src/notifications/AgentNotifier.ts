import { Notice } from 'obsidian';
import { MAX_NOTIFICATION_ACTIONS } from '../constants';
import type { ObsidianPiSettings } from '../types';

export enum NotificationMode {
  Off = 'off',
  InAppNotice = 'inApp',
  OSNotification = 'os',
  Both = 'both',
}

export interface AgentEvent {
  instanceId: string;
  cwd: string;
  type: 'start' | 'end' | 'error' | 'abort' | 'question' | 'session_start';
  model?: string;
  turns?: number;
  tokens?: number;
  cost?: number;
  message?: string;
  /** Present when type === 'session_start'. */
  reason?: 'startup' | 'reload' | 'new' | 'resume' | 'fork';
  /** Absolute path to the active session file, present when type === 'session_start'. */
  sessionFile?: string;
  /** Correlates a 'question' event with the in-flight question_user tool call (terminal mode). */
  questionId?: string;
  /** Selectable option labels for a 'question' event (terminal mode). */
  options?: string[];
  /** Whether freeform text answers are accepted for a 'question' event (terminal mode). */
  allowFreeform?: boolean;
  /** Current thinking level (low/medium/high/none), sent on every lifecycle event as a live snapshot. */
  thinkingLevel?: string;
  /** Current context window usage in tokens, or null when unknown (e.g. right after compaction). */
  contextTokens?: number | null;
  /** The active model's context window size, in tokens. */
  contextWindow?: number;
  /** Context usage as a percentage of contextWindow, or null when unknown. */
  contextPercent?: number | null;
}

/**
 * Match a notification reply against option labels by exact text (case-insensitive)
 * or 1-based index. Used by the interactive-notification reply handlers.
 * Returns the canonical option label, or null if no match.
 */
export function matchOptionReply(reply: string, options: string[]): string | null {
  const trimmed = reply.trim();
  if (!trimmed) return null;
  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1];
  const lower = trimmed.toLowerCase();
  return options.find((o) => o.toLowerCase() === lower) ?? null;
}

interface NotificationParts {
  title: string;
  body: string;
}

export interface InteractiveNotificationOptions {
  title: string;
  body: string;
  /** Option labels rendered as native action buttons (macOS only, caller should cap to ~3). */
  actions?: string[];
  /** Show an inline text-reply field (macOS only). */
  reply?: boolean;
  replyPlaceholder?: string;
  silent?: boolean;
}

export interface InteractiveNotificationResult {
  /** Index into the `actions` array the user clicked, if any. */
  actionIndex?: number;
  /** Text typed into the reply field, if any. */
  replyText?: string;
}

/**
 * Dispatches Obsidian Notices and/or native OS notifications for agent lifecycle
 * events (finish, error, abort, question). Reads live settings on every event so
 * runtime changes to mode/sound/focusOnly take effect immediately.
 */
export class AgentNotifier {
  private readonly getSettings: () => ObsidianPiSettings;
  private readonly lastFired = new Map<string, number>();
  private requestedPermission = false;
  /** Test-only override for the Electron Notification class lookup (bypasses require()). */
  private readonly electronNotificationCtorOverride?: () => unknown;
  /**
   * Terminal-mode answer channel: when an interactive question notification is
   * answered, the resolved answer is routed here so main.ts can forward it to
   * the owning PtyClient as a `pi:answer:` APC marker (which the
   * obsidian-bridge proxy feeds back to the in-flight question_user panel).
   */
  onAnswer?: (instanceId: string, questionId: string, answer: string, wasCustom: boolean) => void;

  constructor(getSettings: () => ObsidianPiSettings, electronNotificationCtorOverride?: () => unknown) {
    this.electronNotificationCtorOverride = electronNotificationCtorOverride;
    this.getSettings = getSettings;
  }

  handle(event: AgentEvent): void {
    if (event.type === 'start') return;

    const settings = this.getSettings();
    const mode = settings.agentNotificationMode ?? NotificationMode.Off;
    if (mode === NotificationMode.Off) return;

    // Dedup by questionId when present so distinct questions each fire even if
    // they arrive close together, while suppressing re-emits of the same one.
    const key = event.questionId
      ? `${event.instanceId}:question:${event.questionId}`
      : `${event.instanceId}:${event.type}`;
    const now = Date.now();
    const last = this.lastFired.get(key) ?? 0;
    if (now - last < 300) return;
    this.lastFired.set(key, now);

    // Interactive question (terminal mode): the obsidian-bridge emits the real
    // question text + options + a questionId; show a native notification with
    // action buttons + inline reply and route the answer back to the PTY.
    if (event.type === 'question' && event.questionId && event.options) {
      void this.handleInteractiveQuestion(event);
      return;
    }

    const { title, body } = this.buildNotification(event);
    const label = this.instanceLabel(event);
    const displayBody = label ? `[${label}] ${body}` : body;

    if (mode === NotificationMode.InAppNotice || mode === NotificationMode.Both) {
      new Notice(displayBody, 4000);
    }

    // Plain OS notification for everything that isn't an interactive question
    // (payload-bearing questions are handled above via handleInteractiveQuestion
    // and return early). Payload-less 'question' events — e.g. a stale
    // obsidian-bridge that hasn't been restarted into the new payload format —
    // still surface here so the user is never left with no notification at all.
    if (mode === NotificationMode.OSNotification || mode === NotificationMode.Both) {
      if (settings.agentNotificationFocusOnly && document.hasFocus()) return;
      void this.showOS(title, displayBody, !settings.agentNotificationSound);
    }
  }

  /**
   * Fires a native, interactive OS notification for a terminal-mode question
   * (question text as body, options as action buttons, inline reply for
   * freeform answers) and routes the resolved answer back through `onAnswer`.
   * A short in-app Notice is also shown for at-a-glance visibility.
   */
  private async handleInteractiveQuestion(event: AgentEvent): Promise<void> {
    const options = event.options ?? [];
    const question = event.message ?? 'Agent needs input';
    const label = this.instanceLabel(event);
    const prefix = label ? `[${label}] ` : '';

    // Brief in-app notice so the question is visible even with Obsidian focused
    // (OS notifications are suppressed by focusOnly in that case).
    new Notice(`${prefix}⏳ ${question}`, 5000);

    const actions = options.slice(0, MAX_NOTIFICATION_ACTIONS);
    const numbered = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
    const result = await this.showInteractive({
      title: 'pi needs input',
      body: numbered ? `${question}\n\n${numbered}` : question,
      actions,
      reply: true,
      replyPlaceholder: 'Type an answer or option number…',
    });
    if (!result) return; // OS notifications off/unsupported/dismissed/focused — answer in terminal

    if (!event.questionId || !this.onAnswer) return;

    if (result.actionIndex != null) {
      const answer = actions[result.actionIndex];
      if (answer != null) this.onAnswer(event.instanceId, event.questionId, answer, false);
      return;
    }

    if (result.replyText != null) {
      const matched = matchOptionReply(result.replyText, options);
      if (matched != null) {
        this.onAnswer(event.instanceId, event.questionId, matched, false);
      } else if (event.allowFreeform !== false) {
        this.onAnswer(event.instanceId, event.questionId, result.replyText, true);
      } else {
        new Notice(
          `pi: reply "${result.replyText}" didn't match any option — answer in the terminal.`,
          6000,
        );
      }
    }
  }

  /**
   * Fires a native, interactive OS notification (macOS action buttons + inline
   * reply) and resolves once the user picks an action, types a reply, or the
   * notification is dismissed/closed. Returns null when OS notifications are
   * disabled by settings, the window is focused with focusOnly set, native
   * notifications aren't available in this environment, or the user dismissed
   * it without answering — callers should keep their fallback UI (e.g. a modal)
   * open in all of those cases.
   */
  async showInteractive(
    opts: InteractiveNotificationOptions,
  ): Promise<InteractiveNotificationResult | null> {
    const settings = this.getSettings();
    const mode = settings.agentNotificationMode ?? NotificationMode.Off;
    if (mode !== NotificationMode.OSNotification && mode !== NotificationMode.Both) return null;
    if (settings.agentNotificationInteractive === false) return null;
    if (settings.agentNotificationFocusOnly && document.hasFocus()) return null;

    const ElectronNotification = this.getElectronNotificationCtor();
    const nativeAvailable = !!(ElectronNotification && ElectronNotification.isSupported?.() !== false);

    if (nativeAvailable) {
      try {
        return await new Promise((resolve) => {
          let settled = false;
          const settle = (result: InteractiveNotificationResult | null): void => {
            if (settled) return;
            settled = true;
            resolve(result);
          };
          // eslint-disable-next-line new-cap
          const n = new ElectronNotification({
            title: opts.title,
            body: opts.body,
            silent: opts.silent ?? !settings.agentNotificationSound,
            actions: opts.actions?.map((text) => ({ type: 'button', text })),
            hasReply: opts.reply ?? false,
            replyPlaceholder: opts.replyPlaceholder,
          });
          n.on('action', (_e: unknown, index: number) => settle({ actionIndex: index }));
          n.on('reply', (_e: unknown, reply: string) => settle({ replyText: reply }));
          n.on('close', () => settle(null));
          n.on('failed', () => settle(null));
          n.show();
        });
      } catch (e) {
        console.warn('[obsidian-pi] native interactive notification failed, falling back to plain', e);
      }
    } else {
      console.warn('[obsidian-pi] interactive notifications unavailable; falling back to plain notification');
    }

    // Fallback: a plain web Notification (the same path agent_end uses, known to
    // display) so the question + numbered options are at least visible. No
    // buttons/reply can be captured from it — return null and leave the
    // terminal panel open for the user to answer there.
    await this.showOS(opts.title, opts.body, opts.silent ?? !settings.agentNotificationSound);
    return null;
  }

  /**
   * Resolve a Notification constructor that supports macOS action buttons +
   * inline reply. Tries, in order:
   *   1. `require('electron').Notification` — the renderer-exposed Electron
   *      class (supports actions/hasReply when available).
   *   2. `require('@electron/remote').require('electron').Notification` — the
   *      MAIN-process Notification via @electron/remote, used by other parts of
   *      this plugin (PromptPopout) and the most reliable path for action
   *      buttons when the renderer class isn't exposed.
   *   3. `require('electron').remote?.Notification` — legacy Electron fallback.
   * Returns null when none are available.
   */
  private getElectronNotificationCtor(): any {
    if (this.electronNotificationCtorOverride) return this.electronNotificationCtorOverride();
    if (typeof require !== 'function') return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const r = require('electron');
      if (r?.Notification) return r.Notification;
    } catch { /* try next */ }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const remote = require('@electron/remote');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mainElectron = remote?.require?.('electron');
      if (mainElectron?.Notification) return mainElectron.Notification;
    } catch { /* try next */ }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const r = require('electron');
      if (r?.remote?.Notification) return r.remote.Notification;
    } catch { /* none */ }
    return null;
  }

  private buildNotification(event: AgentEvent): NotificationParts {
    switch (event.type) {
      case 'end': {
        const model = event.model ?? 'unknown';
        const turns = event.turns ?? 0;
        const turnsStr = `${turns} turn${turns !== 1 ? 's' : ''}`;
        const tokensStr =
          event.tokens != null && event.tokens > 0 ? ` · ${event.tokens} out` : '';
        const costStr =
          event.cost != null && event.cost > 0 ? ` · $${event.cost.toFixed(4)}` : '';
        const summary = `${model} · ${turnsStr}${tokensStr}${costStr}`;
        return { title: 'Agent finished', body: `✓ ${summary}` };
      }
      case 'abort':
        return { title: 'Agent aborted', body: '✖ Aborted' };
      case 'error':
        return {
          title: 'Agent error',
          body: `✖ Error: ${event.message ?? 'unknown error'}`,
        };
      case 'question':
        return {
          title: 'Agent needs input',
          body: '⏳ Agent is waiting for your input',
        };
      default:
        return { title: 'obsidian-pi', body: '' };
    }
  }

  private instanceLabel(event: AgentEvent): string | undefined {
    if (event.instanceId && event.instanceId !== 'default') {
      return event.instanceId;
    }
    if (event.cwd) {
      return event.cwd.split(/[\\/]/).pop();
    }
    return undefined;
  }

  private async showOS(title: string, body: string, silent: boolean): Promise<void> {
    if (typeof window === 'undefined' || !('Notification' in window)) return;

    const permission = await this.ensurePermission();
    if (permission !== 'granted') return;

    try {
      // eslint-disable-next-line no-new
      new Notification(title, { body, silent });
    } catch {
      // Native notifications may be unavailable in some Obsidian builds; fail quietly.
    }
  }

  private async ensurePermission(): Promise<NotificationPermission> {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'denied';

    const current = Notification.permission;
    if (current === 'granted' || current === 'denied') return current;

    // current === 'default'; request once and remember that we asked.
    if (this.requestedPermission) return 'default';
    this.requestedPermission = true;

    try {
      const result = await Notification.requestPermission();
      return result;
    } catch {
      return 'default';
    }
  }
}

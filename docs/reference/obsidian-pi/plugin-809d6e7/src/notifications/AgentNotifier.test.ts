/**
 * Unit tests for AgentNotifier notification dispatch.
 *
 * Covers the notification mode matrix (off / inApp / os / both), the 300 ms
 * dedup guard, sound + focus-only options, and instance attribution.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('obsidian', () => ({
  Notice: vi.fn(),
}));

import { AgentNotifier, NotificationMode, type AgentEvent } from './AgentNotifier';
import { DEFAULT_SETTINGS, type ObsidianPiSettings } from '../types';
import { Notice } from 'obsidian';

function settingsFactory(overrides: Partial<ObsidianPiSettings> = {}) {
  const settings: ObsidianPiSettings = { ...DEFAULT_SETTINGS, ...overrides };
  return { settings, getSettings: () => settings };
}

function baseEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    instanceId: 'default',
    cwd: '/vault/project',
    type: 'end',
    model: 'claude',
    turns: 3,
    tokens: 120,
    cost: 0.0123,
    ...overrides,
  };
}

/** Access the mocked browser Notification constructor placed on globalThis. */
function getNotificationMock(): ReturnType<typeof vi.fn> {
  return (globalThis as unknown as { Notification: ReturnType<typeof vi.fn> }).Notification;
}

/** Access the mocked `document.hasFocus` spy. */
function getHasFocus(): ReturnType<typeof vi.fn> {
  return (globalThis as unknown as { document: { hasFocus: ReturnType<typeof vi.fn> } }).document.hasFocus;
}

describe('AgentNotifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (Notice as any).mockClear();

    const NotificationMock = vi.fn();
    (globalThis as unknown as Record<string, unknown>).Notification = NotificationMock;
    Object.defineProperty(NotificationMock, 'permission', {
      value: 'granted',
      writable: true,
      configurable: true,
    });
    Object.defineProperty(NotificationMock, 'requestPermission', {
      value: vi.fn(async () => 'granted'),
      writable: true,
      configurable: true,
    });

    (globalThis as unknown as Record<string, unknown>).document = {
      hasFocus: vi.fn(() => false),
    };

    (globalThis as unknown as Record<string, unknown>).window = {
      Notification: NotificationMock,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores start events regardless of mode', () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.Both });
    const notifier = new AgentNotifier(getSettings);

    notifier.handle(baseEvent({ type: 'start' }));

    expect(Notice).not.toHaveBeenCalled();
    expect(getNotificationMock()).not.toHaveBeenCalled();
  });

  it('mode "off" produces no Notice and no Notification', () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.Off });
    const notifier = new AgentNotifier(getSettings);

    notifier.handle(baseEvent());

    expect(Notice).not.toHaveBeenCalled();
    expect(getNotificationMock()).not.toHaveBeenCalled();
  });

  it('mode "inApp" calls Notice once and does not call Notification', () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.InAppNotice });
    const notifier = new AgentNotifier(getSettings);

    notifier.handle(baseEvent());

    expect(Notice).toHaveBeenCalledTimes(1);
    expect(Notice).toHaveBeenCalledWith(
      expect.stringContaining('claude · 3 turns · 120 out · $0.0123'),
      4000,
    );
    expect(getNotificationMock()).not.toHaveBeenCalled();
  });

  it('mode "os" with granted permission calls Notification once and not Notice', async () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.OSNotification });
    const notifier = new AgentNotifier(getSettings);

    notifier.handle(baseEvent());
    await Promise.resolve(); // flush microtask from async showOS

    expect(getNotificationMock()).toHaveBeenCalledTimes(1);
    expect(getNotificationMock()).toHaveBeenCalledWith(
      'Agent finished',
      expect.objectContaining({
        body: expect.stringContaining('claude · 3 turns · 120 out · $0.0123'),
        silent: false,
      }),
    );
    expect(Notice).not.toHaveBeenCalled();
  });

  it('mode "both" calls Notice and Notification once each', async () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.Both });
    const notifier = new AgentNotifier(getSettings);

    notifier.handle(baseEvent());
    await Promise.resolve();

    expect(Notice).toHaveBeenCalledTimes(1);
    expect(getNotificationMock()).toHaveBeenCalledTimes(1);
  });

  it('dedup guard drops duplicate instanceId+type within 300 ms', () => {
    vi.useFakeTimers();
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.InAppNotice });
    const notifier = new AgentNotifier(getSettings);

    notifier.handle(baseEvent({ type: 'error', message: 'boom' }));
    notifier.handle(baseEvent({ type: 'error', message: 'boom' }));
    vi.advanceTimersByTime(299);
    notifier.handle(baseEvent({ type: 'error', message: 'still boom' }));

    expect(Notice).toHaveBeenCalledTimes(1);
    expect(Notice).toHaveBeenCalledWith('[project] ✖ Error: boom', 4000);

    vi.advanceTimersByTime(1);
    notifier.handle(baseEvent({ type: 'error', message: 'after cooldown' }));

    expect(Notice).toHaveBeenCalledTimes(2);
  });

  it('agentNotificationSound false sets Notification silent to true', async () => {
    const { getSettings } = settingsFactory({
      agentNotificationMode: NotificationMode.OSNotification,
      agentNotificationSound: false,
    });
    const notifier = new AgentNotifier(getSettings);

    notifier.handle(baseEvent());
    await Promise.resolve();

    expect(getNotificationMock()).toHaveBeenCalledWith(
      'Agent finished',
      expect.objectContaining({ silent: true }),
    );
  });

  it('focus-only suppresses OS notifications when Obsidian is focused (inApp still fires)', async () => {
    const { getSettings } = settingsFactory({
      agentNotificationMode: NotificationMode.Both,
      agentNotificationFocusOnly: true,
    });
    const notifier = new AgentNotifier(getSettings);
    getHasFocus().mockReturnValue(true);

    notifier.handle(baseEvent());
    await Promise.resolve();

    expect(getNotificationMock()).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledTimes(1);
  });

  it('non-default instanceId prefixes the Notice body with the instance label', () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.InAppNotice });
    const notifier = new AgentNotifier(getSettings);

    notifier.handle(baseEvent({ instanceId: 'sdk-repo' }));

    expect(Notice).toHaveBeenCalledWith(
      '[sdk-repo] ✓ claude · 3 turns · 120 out · $0.0123',
      4000,
    );
  });

  it('payload-less question events fall back to the plain OS Notification (stale-bridge safety)', async () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.Both });
    const notifier = new AgentNotifier(getSettings);

    notifier.handle(baseEvent({ type: 'question' }));
    await Promise.resolve();

    // In-app Notice + plain OS notification both fire so the user is never left
    // with nothing when the bridge has not been restarted into the payload format.
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(getNotificationMock()).toHaveBeenCalledTimes(1);
  });
});

// ─── showInteractive() ────────────────────────────────────────────────────────

/** Fake Electron Notification instance supporting on()/show() and event emission. */
class FakeElectronNotification {
  static instances: FakeElectronNotification[] = [];
  static isSupported = vi.fn(() => true);
  private handlers = new Map<string, (...args: unknown[]) => void>();
  shown = false;

  constructor(public opts: Record<string, unknown>) {
    FakeElectronNotification.instances.push(this);
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.set(event, handler);
  }

  show(): void {
    this.shown = true;
  }

  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args);
  }
}

describe('AgentNotifier.showInteractive', () => {
  beforeEach(() => {
    FakeElectronNotification.instances = [];
    FakeElectronNotification.isSupported = vi.fn(() => true);
    (globalThis as unknown as Record<string, unknown>).document = {
      hasFocus: vi.fn(() => false),
    };
  });

  const ctorOverride = () => FakeElectronNotification;

  it('returns null when notification mode is off', async () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.Off });
    const notifier = new AgentNotifier(getSettings, ctorOverride);

    const result = await notifier.showInteractive({ title: 't', body: 'b' });

    expect(result).toBeNull();
    expect(FakeElectronNotification.instances).toHaveLength(0);
  });

  it('returns null when inApp-only (OS notifications not requested)', async () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.InAppNotice });
    const notifier = new AgentNotifier(getSettings, ctorOverride);

    const result = await notifier.showInteractive({ title: 't', body: 'b' });

    expect(result).toBeNull();
  });

  it('returns null when agentNotificationInteractive is disabled', async () => {
    const { getSettings } = settingsFactory({
      agentNotificationMode: NotificationMode.OSNotification,
      agentNotificationInteractive: false,
    });
    const notifier = new AgentNotifier(getSettings, ctorOverride);

    const result = await notifier.showInteractive({ title: 't', body: 'b' });

    expect(result).toBeNull();
    expect(FakeElectronNotification.instances).toHaveLength(0);
  });

  it('resolves with actionIndex when the user clicks an action button', async () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.OSNotification });
    const notifier = new AgentNotifier(getSettings, ctorOverride);

    const pending = notifier.showInteractive({
      title: 'pi needs input',
      body: 'Which approach?',
      actions: ['A', 'B'],
      reply: true,
    });
    await Promise.resolve();

    expect(FakeElectronNotification.instances).toHaveLength(1);
    const n = FakeElectronNotification.instances[0];
    expect(n.opts.actions).toEqual([{ type: 'button', text: 'A' }, { type: 'button', text: 'B' }]);
    expect(n.opts.hasReply).toBe(true);
    expect(n.shown).toBe(true);

    n.emit('action', {}, 1);

    await expect(pending).resolves.toEqual({ actionIndex: 1 });
  });

  it('resolves with replyText when the user types an inline reply', async () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.OSNotification });
    const notifier = new AgentNotifier(getSettings, ctorOverride);

    const pending = notifier.showInteractive({ title: 't', body: 'b', reply: true });
    await Promise.resolve();

    FakeElectronNotification.instances[0].emit('reply', {}, 'my custom answer');

    await expect(pending).resolves.toEqual({ replyText: 'my custom answer' });
  });

  it('resolves null when the notification is closed without an answer', async () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.OSNotification });
    const notifier = new AgentNotifier(getSettings, ctorOverride);

    const pending = notifier.showInteractive({ title: 't', body: 'b' });
    await Promise.resolve();

    FakeElectronNotification.instances[0].emit('close');

    await expect(pending).resolves.toBeNull();
  });

  it('returns null when Electron Notification.isSupported() is false', async () => {
    FakeElectronNotification.isSupported = vi.fn(() => false);
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.OSNotification });
    const notifier = new AgentNotifier(getSettings, ctorOverride);

    const result = await notifier.showInteractive({ title: 't', body: 'b' });

    expect(result).toBeNull();
    expect(FakeElectronNotification.instances).toHaveLength(0);
  });
});

// ─── Terminal-mode question flow (handle → showInteractive → onAnswer) ────────

describe('AgentNotifier terminal-mode question', () => {
  beforeEach(() => {
    FakeElectronNotification.instances = [];
    FakeElectronNotification.isSupported = vi.fn(() => true);
    (globalThis as unknown as Record<string, unknown>).document = {
      hasFocus: vi.fn(() => false),
    };
  });

  const ctorOverride = () => FakeElectronNotification;

  it('fires an interactive notification and routes an action-button answer to onAnswer', async () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.OSNotification });
    const notifier = new AgentNotifier(getSettings, ctorOverride);
    const answers: Array<{ instanceId: string; questionId: string; answer: string; wasCustom: boolean }> = [];
    notifier.onAnswer = (instanceId, questionId, answer, wasCustom) =>
      answers.push({ instanceId, questionId, answer, wasCustom });

    notifier.handle({
      instanceId: 'default',
      cwd: '/vault',
      type: 'question',
      questionId: 'q-1',
      message: 'Which approach?',
      options: ['A', 'B', 'C'],
      allowFreeform: true,
    });
    await Promise.resolve();

    expect(FakeElectronNotification.instances).toHaveLength(1);
    const n = FakeElectronNotification.instances[0];
    expect(n.opts.actions).toEqual([
      { type: 'button', text: 'A' },
      { type: 'button', text: 'B' },
      { type: 'button', text: 'C' },
    ]);
    expect(n.opts.hasReply).toBe(true);
    expect(n.opts.body).toContain('Which approach?');
    expect(n.opts.body).toContain('1. A');

    n.emit('action', {}, 1);
    await Promise.resolve();
    await Promise.resolve();

    expect(answers).toEqual([{ instanceId: 'default', questionId: 'q-1', answer: 'B', wasCustom: false }]);
  });

  it('routes a matching reply (by index) as a non-custom answer', async () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.OSNotification });
    const notifier = new AgentNotifier(getSettings, ctorOverride);
    const answers: string[] = [];
    notifier.onAnswer = (_iid, _qid, answer) => answers.push(answer);

    notifier.handle({
      instanceId: 'default', cwd: '/v', type: 'question',
      questionId: 'q-2', message: 'Pick', options: ['Red', 'Green', 'Blue'], allowFreeform: true,
    });
    await Promise.resolve();
    FakeElectronNotification.instances[0].emit('reply', {}, '3');
    await Promise.resolve();
    await Promise.resolve();

    expect(answers).toEqual(['Blue']);
  });

  it('routes an unmatched reply as a custom answer when allowFreeform is true', async () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.OSNotification });
    const notifier = new AgentNotifier(getSettings, ctorOverride);
    const answers: Array<{ answer: string; wasCustom: boolean }> = [];
    notifier.onAnswer = (_iid, _qid, answer, wasCustom) => answers.push({ answer, wasCustom });

    notifier.handle({
      instanceId: 'default', cwd: '/v', type: 'question',
      questionId: 'q-3', message: 'Pick', options: ['A', 'B'], allowFreeform: true,
    });
    await Promise.resolve();
    FakeElectronNotification.instances[0].emit('reply', {}, 'something totally custom');
    await Promise.resolve();
    await Promise.resolve();

    expect(answers).toEqual([{ answer: 'something totally custom', wasCustom: true }]);
  });

  it('does not route an unmatched reply when allowFreeform is false', async () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.OSNotification });
    const notifier = new AgentNotifier(getSettings, ctorOverride);
    const answers: string[] = [];
    notifier.onAnswer = (_iid, _qid, answer) => answers.push(answer);

    notifier.handle({
      instanceId: 'default', cwd: '/v', type: 'question',
      questionId: 'q-4', message: 'Pick', options: ['A', 'B'], allowFreeform: false,
    });
    await Promise.resolve();
    FakeElectronNotification.instances[0].emit('reply', {}, 'mystery');
    await Promise.resolve();
    await Promise.resolve();

    expect(answers).toEqual([]);
  });

  it('dedups by questionId so the same question does not fire twice', () => {
    const { getSettings } = settingsFactory({ agentNotificationMode: NotificationMode.OSNotification });
    const notifier = new AgentNotifier(getSettings, ctorOverride);

    notifier.handle({ instanceId: 'default', cwd: '/v', type: 'question', questionId: 'q', message: 'm', options: ['A'] });
    notifier.handle({ instanceId: 'default', cwd: '/v', type: 'question', questionId: 'q', message: 'm', options: ['A'] });

    expect(FakeElectronNotification.instances).toHaveLength(1);
  });
});

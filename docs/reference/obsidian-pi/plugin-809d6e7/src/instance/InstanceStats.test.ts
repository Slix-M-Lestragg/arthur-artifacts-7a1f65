import { describe, expect, it } from 'vitest';
import { buildInstanceTooltip, updateInstanceStats, type InstanceStats } from './InstanceStats';
import type { PiInstance } from './InstanceManager';
import type { AgentEvent } from '../notifications/AgentNotifier';
import type { PiTerminalIconState } from '../views/TerminalIcon';

function makeInstance(overrides: Partial<{
  name: string;
  iconState: PiTerminalIconState;
  stats: InstanceStats;
  ptyState: string;
}> = {}): PiInstance {
  return {
    config: { id: 'default', name: overrides.name ?? 'Default', cwd: '' },
    iconState: overrides.iconState ?? 'idle',
    stats: overrides.stats ?? {},
    ptyClient: overrides.ptyState ? ({ state: overrides.ptyState } as any) : null,
  } as unknown as PiInstance;
}

function endEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    instanceId: 'default', cwd: '/v', type: 'end',
    model: 'claude', turns: 3, tokens: 120, cost: 0.0123,
    ...overrides,
  };
}

describe('updateInstanceStats', () => {
  it('captures model/turns/tokens/cost on "end" and clears a prior error', () => {
    const stats: InstanceStats = { lastErrorMessage: 'boom' };
    updateInstanceStats(stats, endEvent());

    expect(stats).toMatchObject({
      lastEventType: 'end', model: 'claude', turns: 3, tokens: 120, cost: 0.0123,
      lastErrorMessage: undefined,
    });
    expect(stats.lastEventAt).toBeTypeOf('number');
  });

  it('captures the error message on "error"', () => {
    const stats: InstanceStats = {};
    updateInstanceStats(stats, { instanceId: 'd', cwd: '/v', type: 'error', message: 'kaboom' });

    expect(stats.lastEventType).toBe('error');
    expect(stats.lastErrorMessage).toBe('kaboom');
  });

  it('clears a prior error message on "start" (new turn beginning)', () => {
    const stats: InstanceStats = { lastErrorMessage: 'old error' };
    updateInstanceStats(stats, { instanceId: 'd', cwd: '/v', type: 'start' });

    expect(stats.lastEventType).toBe('start');
    expect(stats.lastErrorMessage).toBeUndefined();
  });

  it('keeps model/thinkingLevel/context fresh regardless of event type', () => {
    const stats: InstanceStats = {};
    updateInstanceStats(stats, {
      instanceId: 'd', cwd: '/v', type: 'question',
      model: 'claude', thinkingLevel: 'high',
      contextTokens: 5000, contextWindow: 200_000, contextPercent: 2.5,
    });

    expect(stats.model).toBe('claude');
    expect(stats.thinkingLevel).toBe('high');
    expect(stats.contextTokens).toBe(5000);
    expect(stats.contextWindow).toBe(200_000);
    expect(stats.contextPercent).toBe(2.5);
  });

  it('a null contextTokens (e.g. post-compaction) overwrites a previous known value', () => {
    const stats: InstanceStats = { contextTokens: 5000 };
    updateInstanceStats(stats, { instanceId: 'd', cwd: '/v', type: 'start', contextTokens: null });

    expect(stats.contextTokens).toBeNull();
  });

  it('omitting a live field leaves the previous value untouched', () => {
    const stats: InstanceStats = { model: 'claude', thinkingLevel: 'high' };
    updateInstanceStats(stats, { instanceId: 'd', cwd: '/v', type: 'question' });

    expect(stats.model).toBe('claude');
    expect(stats.thinkingLevel).toBe('high');
  });
});

describe('buildInstanceTooltip', () => {
  it('includes name and a running status line, and omits the cwd', () => {
    const instance = makeInstance({ iconState: 'running' });
    const text = buildInstanceTooltip(instance);

    expect(text).toContain('Default');
    expect(text).toContain('Running');
    expect(text).not.toContain('/Users');
  });

  it('includes the error message for the error state', () => {
    const instance = makeInstance({ iconState: 'error', stats: { lastErrorMessage: 'disk full' } });
    const text = buildInstanceTooltip(instance);

    expect(text).toContain('Error');
    expect(text).toContain('disk full');
  });

  it('includes model + thinking level on one line', () => {
    const instance = makeInstance({ iconState: 'running', stats: { model: 'claude-sonnet', thinkingLevel: 'high' } });
    const text = buildInstanceTooltip(instance);

    expect(text).toContain('claude-sonnet · thinking: high');
  });

  it('omits the thinking-level suffix when it is "none"', () => {
    const instance = makeInstance({ iconState: 'running', stats: { model: 'claude-sonnet', thinkingLevel: 'none' } });
    const text = buildInstanceTooltip(instance);

    expect(text).toContain('claude-sonnet');
    expect(text).not.toContain('thinking:');
  });

  it('includes context usage with window + percent when all are known', () => {
    const instance = makeInstance({
      iconState: 'running',
      stats: { contextTokens: 12_345, contextWindow: 200_000, contextPercent: 6.2 },
    });
    const text = buildInstanceTooltip(instance);

    expect(text).toContain('Context: 12,345 / 200,000 tokens (6%)');
  });

  it('degrades to tokens-only when the context window is unknown', () => {
    const instance = makeInstance({ iconState: 'running', stats: { contextTokens: 12_345 } });
    const text = buildInstanceTooltip(instance);

    expect(text).toContain('Context: 12,345 tokens');
  });

  it('omits the context line entirely when contextTokens is null (e.g. post-compaction)', () => {
    const instance = makeInstance({ iconState: 'running', stats: { contextTokens: null, contextWindow: 200_000 } });
    const text = buildInstanceTooltip(instance);

    expect(text).not.toContain('Context:');
  });

  it('includes cost when known', () => {
    const stats: InstanceStats = {};
    updateInstanceStats(stats, endEvent());
    const instance = makeInstance({ iconState: 'seen', stats });
    const text = buildInstanceTooltip(instance);

    expect(text).toContain('Cost: $0.0123');
  });

  it('falls back to ptyClient state when idle and not connected', () => {
    const instance = makeInstance({ iconState: 'idle', ptyState: 'disconnected' });
    const text = buildInstanceTooltip(instance);

    expect(text).toContain('Not connected');
  });

  it('shows "Idle" when idle and connected', () => {
    const instance = makeInstance({ iconState: 'idle', ptyState: 'connected' });
    const text = buildInstanceTooltip(instance);

    expect(text).toContain('Idle');
  });

  it('shows a coarse "ago" line when lastEventAt is set', () => {
    const stats: InstanceStats = { lastEventAt: Date.now() - 65_000 };
    const instance = makeInstance({ iconState: 'seen', stats });
    const text = buildInstanceTooltip(instance);

    expect(text).toMatch(/\dm ago/);
  });
});

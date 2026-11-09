import { describe, expect, it } from 'vitest';
import {
  NEW_SESSION_ITEM,
  formatAgo,
  formatWorkingDirectory,
  isLiveMirrorSession,
  isNewSessionItem,
  sessionDisplayName,
} from './AhpSessionPickerModal';
import type { SessionSummary } from '../transport/AhpClient';

describe('AhpSessionPickerModal helpers', () => {
  it('NEW_SESSION_ITEM is a sentinel and isNewSessionItem identifies only it', () => {
    expect(isNewSessionItem(NEW_SESSION_ITEM)).toBe(true);
    expect(isNewSessionItem({ resource: 'r', title: 't', status: 0 })).toBe(false);
  });

  it('sessionDisplayName falls back to "(untitled session)" for empty or whitespace titles', () => {
    expect(sessionDisplayName({ resource: 'r', title: '', status: 0 })).toBe('(untitled session)');
    expect(sessionDisplayName({ resource: 'r', title: '   ', status: 0 })).toBe('(untitled session)');
    expect(sessionDisplayName({ resource: 'r', title: 'My session', status: 0 })).toBe('My session');
  });
});

describe('formatWorkingDirectory', () => {
  it('returns the last two path segments, prefixed with an ellipsis when deeper', () => {
    expect(formatWorkingDirectory('file:///home/user/projects/alpha')).toBe('…/projects/alpha');
    expect(formatWorkingDirectory('/home/user/alpha')).toBe('…/user/alpha');
    expect(formatWorkingDirectory('alpha')).toBe('alpha');
  });

  it('returns undefined for empty or missing directories', () => {
    expect(formatWorkingDirectory(undefined)).toBeUndefined();
    expect(formatWorkingDirectory('')).toBeUndefined();
  });
});

describe('formatAgo', () => {
  it('returns a coarse relative time for recent timestamps', () => {
    expect(formatAgo(new Date(Date.now() - 2_000).toISOString())).toBe('just now');
    expect(formatAgo(new Date(Date.now() - 30_000).toISOString())).toBe('30s ago');
    expect(formatAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
  });

  it('returns undefined for missing or invalid timestamps', () => {
    expect(formatAgo(undefined)).toBeUndefined();
    expect(formatAgo('not-a-date')).toBeUndefined();
  });
});

describe('isLiveMirrorSession', () => {
  it('trusts explicit terminalMode when present', () => {
    expect(isLiveMirrorSession({ resource: 'r', title: 't', status: 0, terminalMode: 'external' })).toBe(true);
    expect(isLiveMirrorSession({ resource: 'r', title: 't', status: 0, terminalMode: 'server-spawned' })).toBe(false);
  });

  it('falls back to the provider heuristic when terminalMode is absent', () => {
    expect(isLiveMirrorSession({ resource: 'r', title: 't', status: 0, provider: 'pi-ahp-server' })).toBe(true);
    expect(isLiveMirrorSession({ resource: 'r', title: 't', status: 0, provider: 'pi' })).toBe(false);
    expect(isLiveMirrorSession({ resource: 'r', title: 't', status: 0 })).toBe(true);
  });
});
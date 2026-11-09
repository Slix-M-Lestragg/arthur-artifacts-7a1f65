/**
 * Unit tests for the defensive settings normalizer (src/utils/normalizeSettings.ts):
 * hand-edited / corrupted data.json payloads must never leak wrong-typed values
 * into typed settings fields.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../types';
import { normalizeSettings } from './normalizeSettings';

describe('normalizeSettings', () => {
  it('returns full defaults for a non-object payload', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('junk')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values and falls back to defaults for wrong types', () => {
    const s = normalizeSettings({
      binaryPath: '/opt/pi/cli.js',
      terminalFontSize: 'huge', // wrong type → default
      terminalScrollback: 9000,
      promptSubmitMode: 'wizard', // not in enum → default
      thinkingLevel: 3, // wrong type → default
      clearPromptOnSubmit: false,
      restoreSessionOnRestart: 'yes', // wrong type → default
    });
    expect(s.binaryPath).toBe('/opt/pi/cli.js');
    expect(s.terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize);
    expect(s.terminalScrollback).toBe(9000);
    expect(s.promptSubmitMode).toBe('apc');
    expect(s.thinkingLevel).toBe('medium');
    expect(s.clearPromptOnSubmit).toBe(false);
    expect(s.restoreSessionOnRestart).toBe(true);
  });

  it('normalizes enum fields onto valid values', () => {
    const s = normalizeSettings({
      promptSurface: 'floating', // legacy/invalid
      agentNotificationMode: 'loud',
      sttLanguage: 'de',
      menubarIconStyle: 'rainbow',
    });
    expect(s.promptSurface).toBe(DEFAULT_SETTINGS.promptSurface);
    expect(s.agentNotificationMode).toBe('off');
    expect(s.sttLanguage).toBe('auto');
    expect(s.menubarIconStyle).toBe('accent');
  });

  it('per-key guards instances[] — drops junk entries, keeps valid ones', () => {
    const s = normalizeSettings({
      instances: [
        { id: 'default', name: 'Default', cwd: '/tmp' },
        'not-an-object',
        { name: 'no id' },
        { id: 42 },
        { id: 'sdk', cwd: 7, model: 'gpt' }, // junk cwd dropped, valid model kept
        null,
      ],
    });
    expect(s.instances).toHaveLength(2);
    expect(s.instances[0]).toMatchObject({ id: 'default', cwd: '/tmp' });
    expect(s.instances[1]).toMatchObject({ id: 'sdk', cwd: '', model: 'gpt' });
    // name missing → id used as fallback
    expect(s.instances[1].name).toBe('sdk');
  });

  it('falls back to the default instance list when instances[] is unusable or empty', () => {
    expect(normalizeSettings({ instances: 'all' }).instances).toEqual(DEFAULT_SETTINGS.instances);
    expect(normalizeSettings({ instances: [null, {}] }).instances).toEqual(DEFAULT_SETTINGS.instances);
  });

  it('deep-merges farmView with per-key type guards', () => {
    const s = normalizeSettings({
      farmView: {
        defaultSort: 'newest', // invalid → default
        liveUpdate: false,
        columnVisibility: ['name', 42, 'status'], // non-strings filtered
        costAlertThreshold: '5', // wrong type → default
        autoCullIdleMinutes: 30,
        tags: { 'ahp-session:/x': ['tag1', 3, 'tag2'] },
        perProviderCaps: { anthropic: 'many' }, // junk dropped → {}
      },
    });
    expect(s.farmView.defaultSort).toBe('modifiedAt-desc');
    expect(s.farmView.liveUpdate).toBe(false);
    expect(s.farmView.columnVisibility).toEqual(['name', 'status']);
    expect(s.farmView.costAlertThreshold).toBe(0);
    expect(s.farmView.autoCullIdleMinutes).toBe(30);
    expect(s.farmView.tags).toEqual({ 'ahp-session:/x': ['tag1', 'tag2'] });
    expect(s.farmView.perProviderCaps).toEqual({});
    // Untouched keys keep defaults:
    expect(s.farmView.density).toBe(DEFAULT_SETTINGS.farmView.density);
  });

  it('normalizes a corrupted farmView object to defaults', () => {
    expect(normalizeSettings({ farmView: 'wide' }).farmView).toEqual(DEFAULT_SETTINGS.farmView);
    expect(normalizeSettings({ farmView: null }).farmView).toEqual(DEFAULT_SETTINGS.farmView);
  });

  it('preserves unknown extra keys verbatim (forward-compat round-trip)', () => {
    const s = normalizeSettings({ someFutureField: { nested: [1, 2] }, legacyThing: 'x' }) as unknown as Record<
      string,
      unknown
    >;
    expect(s.someFutureField).toEqual({ nested: [1, 2] });
    expect(s.legacyThing).toBe('x');
  });

  it('guards knownDevices, lastSessionFile nullability and string fields', () => {
    const s = normalizeSettings({
      knownDevices: ['voyager', 7, 'arthur'],
      lastSessionFile: 123,
      lastTerminalSessionFile: null,
      ahpServerToken: { stolen: 'object' },
    });
    expect(s.knownDevices).toEqual(['voyager', 'arthur']);
    expect(s.lastSessionFile).toBeNull();
    expect(s.lastTerminalSessionFile).toBeNull();
    expect(s.ahpServerToken).toBe('');
  });

  it('unhardcodes the server URL defaults (no private Tailscale IPs)', () => {
    expect(DEFAULT_SETTINGS.ahpServerUrl).toBe('ws://localhost:4500');
    expect(DEFAULT_SETTINGS.sttServerUrl).toBe('');
  });
});
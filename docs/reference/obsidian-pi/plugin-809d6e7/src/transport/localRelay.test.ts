/**
 * Pure tests for the prefer-local URI matcher (src/transport/localRelay.ts):
 * `parseLocalRelayUri` (URI + device name → {device, instanceId} | null) and
 * `matchLocalRelaySession` (session-shaped object → same). No settings, no
 * instance manager, no obsidian imports — these pin the exact matching
 * semantics that the plugin-level prefer-local routing (main.ts
 * openLocalRelaySessionIfLocal) and the Farm view / session browser badges
 * all share.
 */

import { describe, expect, it } from 'vitest';
import { matchLocalRelaySession, parseLocalRelayUri } from './localRelay';

describe('parseLocalRelayUri', () => {
  it('matches an ext URI for the given device, preserving the instance id case', () => {
    expect(parseLocalRelayUri('ahp-session:/ext-voyager-default', 'Voyager')).toEqual({
      device: 'Voyager',
      instanceId: 'default',
    });
    expect(parseLocalRelayUri('ahp-session:/ext-Voyager-Default-Instance', 'voyager')).toEqual({
      device: 'voyager',
      instanceId: 'Default-Instance',
    });
  });

  it('is case-insensitive on both the scheme prefix and the device name', () => {
    expect(parseLocalRelayUri('AHP-SESSION:/EXT-ARTHUR-local-1', 'Arthur')).toEqual({
      device: 'Arthur',
      instanceId: 'local-1',
    });
  });

  it('rejects URIs owned by another device', () => {
    expect(parseLocalRelayUri('ahp-session:/ext-remotehost-default', 'Voyager')).toBeNull();
  });

  it('rejects non-ext resources (hosted sessions)', () => {
    expect(parseLocalRelayUri('ahp-session:/pi-hosted', 'Voyager')).toBeNull();
    expect(parseLocalRelayUri('ahp-chat:/voyager-child', 'Voyager')).toBeNull();
    expect(parseLocalRelayUri('ahp-terminal:/ext-voyager-default', 'Voyager')).toBeNull();
  });

  it('does not confuse device-name prefixes (ext-voyagerX is not ext-voyager)', () => {
    // The trailing '-' in the prefix guard keeps 'ext-voyagerX-default' from
    // matching device 'voyager'.
    expect(parseLocalRelayUri('ahp-session:/ext-voyagerX-default', 'voyager')).toBeNull();
  });

  it('rejects empty instance ids and empty/blank device names', () => {
    expect(parseLocalRelayUri('ahp-session:/ext-voyager-', 'Voyager')).toBeNull();
    expect(parseLocalRelayUri('ahp-session:/ext-voyager-default', '')).toBeNull();
    expect(parseLocalRelayUri('ahp-session:/ext-voyager-default', '   ')).toBeNull();
    expect(parseLocalRelayUri('', 'Voyager')).toBeNull();
  });
});

describe('matchLocalRelaySession', () => {
  it('matches an external row by its hostAgentName against the local device', () => {
    expect(
      matchLocalRelaySession(
        { resource: 'ahp-session:/ext-voyager-default', hostAgentName: 'Voyager' },
        'voyager',
      ),
    ).toEqual({ device: 'Voyager', instanceId: 'default' });
  });

  it('matches a relay row by the resource alone (no hostAgentName on relay rows)', () => {
    expect(
      matchLocalRelaySession({ resource: 'ahp-session:/ext-Voyager-default' }, 'Voyager'),
    ).toEqual({ device: 'Voyager', instanceId: 'default' });
  });

  it('does not let a mismatched hostAgentName smuggle another device in', () => {
    // hostAgentName 'arthur' ≠ local 'voyager' → the resource must still be
    // an ext-voyager URI to match; ext-arthur rows belong to another device.
    expect(
      matchLocalRelaySession(
        { resource: 'ahp-session:/ext-arthur-default', hostAgentName: 'arthur' },
        'Voyager',
      ),
    ).toBeNull();
  });

  it('falls back to the Voyager default when deviceName is empty', () => {
    expect(
      matchLocalRelaySession({ resource: 'ahp-session:/ext-voyager-local-1' }, ''),
    ).toEqual({ device: 'Voyager', instanceId: 'local-1' });
  });
});
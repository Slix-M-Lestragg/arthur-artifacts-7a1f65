import { describe, expect, it, vi } from 'vitest';
import {
  MENUBAR_TRAY_REGISTRY_PROP,
  reclaimStaleTray,
  registerTray,
  unregisterTrayIfCurrent,
} from './MenubarIcon';

/**
 * These test the pure registry helpers backing the tray's self-healing
 * behavior — see MENUBAR_TRAY_REGISTRY_PROP's doc comment. A plain object
 * stands in for the main-process-side `menubar-registry.js` module export: in
 * real usage, the renderer reaches that same cached object via
 * `@electron/remote.require`, but the logic here is agnostic to that — it just
 * needs get/set on a record.
 */

describe('reclaimStaleTray', () => {
  it('destroys a previously-registered tray, if present', () => {
    const destroy = vi.fn();
    const registry = { [MENUBAR_TRAY_REGISTRY_PROP]: { destroy } };
    reclaimStaleTray(registry);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('is a no-op when nothing is registered', () => {
    const registry = { [MENUBAR_TRAY_REGISTRY_PROP]: null };
    expect(() => reclaimStaleTray(registry)).not.toThrow();
  });

  it('is a no-op when the registry itself is null/undefined', () => {
    expect(() => reclaimStaleTray(null)).not.toThrow();
    expect(() => reclaimStaleTray(undefined)).not.toThrow();
  });

  it('swallows an error thrown by a stale tray already gone from the OS', () => {
    const registry = {
      [MENUBAR_TRAY_REGISTRY_PROP]: { destroy: () => { throw new Error('already destroyed'); } },
    };
    expect(() => reclaimStaleTray(registry)).not.toThrow();
  });

  it('respects a custom prop', () => {
    const destroy = vi.fn();
    const registry = { custom: { destroy } };
    reclaimStaleTray(registry, 'custom');
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('registerTray', () => {
  it('sets the registry slot to the given tray', () => {
    const registry = { [MENUBAR_TRAY_REGISTRY_PROP]: null };
    const tray = { id: 'tray-1' };
    registerTray(registry, tray);
    expect(registry[MENUBAR_TRAY_REGISTRY_PROP]).toBe(tray);
  });

  it('overwrites a previous occupant', () => {
    const registry = { [MENUBAR_TRAY_REGISTRY_PROP]: { id: 'old' } };
    const next = { id: 'new' };
    registerTray(registry, next);
    expect(registry[MENUBAR_TRAY_REGISTRY_PROP]).toBe(next);
  });

  it('is a no-op when the registry is null/undefined', () => {
    expect(() => registerTray(null, {})).not.toThrow();
  });
});

describe('unregisterTrayIfCurrent', () => {
  it('clears the slot when it still points at the given tray', () => {
    const tray = { id: 'mine' };
    const registry = { [MENUBAR_TRAY_REGISTRY_PROP]: tray };
    unregisterTrayIfCurrent(registry, tray);
    expect(registry[MENUBAR_TRAY_REGISTRY_PROP]).toBeNull();
  });

  it('does NOT clear the slot if a different tray has since been registered (avoids a race)', () => {
    const mine = { id: 'mine' };
    const someoneElses = { id: 'someone-elses' };
    const registry = { [MENUBAR_TRAY_REGISTRY_PROP]: someoneElses };
    unregisterTrayIfCurrent(registry, mine);
    expect(registry[MENUBAR_TRAY_REGISTRY_PROP]).toBe(someoneElses);
  });

  it('is a no-op when the registry is null/undefined', () => {
    expect(() => unregisterTrayIfCurrent(null, {})).not.toThrow();
  });
});
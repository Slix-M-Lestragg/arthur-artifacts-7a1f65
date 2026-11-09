import * as path from 'path';
import type ObsidianPiPlugin from '../main';
import { toInstanceRow, type InstanceRow } from '../instance/instancePresentation';

// Shared presentation helpers — canonical implementations live in
// `../instance/instancePresentation`; re-exported here for the menubar's
// existing consumers (MenubarMenuBuilder.formatAgo).
export { formatAgo } from '../instance/instancePresentation';

/**
 * Serializable view of one pi terminal instance, suitable for shipping over
 * the menubar IPC socket. Exactly the shared {@link InstanceRow} projection —
 * previously a field-for-field duplicate of it.
 */
export interface MenubarInstance extends InstanceRow {}

/**
 * Serializable view of *this* reporter's vault: a stable id, a display name,
 * and the configured pi instances running in it. One of these is published
 * per Obsidian app instance; the leader aggregates them into the tray menu,
 * grouped by {@link vaultId}.
 */
export interface MenubarVaultSnapshot {
  vaultId: string;
  vaultName: string;
  vaultPath: string;
  instances: MenubarInstance[];
}

/** Wire message published by a reporter (or the leader, for its own vault). */
export interface MenubarReport {
  /** Unique id for the publishing plugin instance (stable for the socket's lifetime). */
  reporterId: string;
  vault: MenubarVaultSnapshot;
  emittedAt: number;
}

/**
 * FNV-1a 32-bit hash → base36 string. Deterministic and process-independent,
 * so two Obsidian apps open on the same vault path derive the same vault id
 * (and thus collapse into a single submenu). Non-cryptographic on purpose.
 */
export function vaultIdFromPath(vaultPath: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < vaultPath.length; i++) {
    h ^= vaultPath.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Vault display name, preferring Obsidian's configured name over the basename. */
export function vaultNameOf(plugin: ObsidianPiPlugin): string {
  const name = plugin.app.vault.getName();
  if (name) return name;
  const base = (plugin.app.vault.adapter as { basePath?: string }).basePath ?? '';
  return path.basename(base) || 'Vault';
}

/** Absolute vault root path (may be empty in exotic non-fs adapters). */
export function vaultPathOf(plugin: ObsidianPiPlugin): string {
  return (plugin.app.vault.adapter as { basePath?: string }).basePath ?? '';
}

/** Build the serializable snapshot for the local vault from configured instances. */
export function deriveMenubarSnapshot(plugin: ObsidianPiPlugin, reporterId: string): MenubarReport {
  const vaultPath = vaultPathOf(plugin);
  const vaultName = vaultNameOf(plugin);
  const vaultId = vaultIdFromPath(vaultPath);

  const instances: MenubarInstance[] = plugin.settings.instances.map((cfg) =>
    toInstanceRow(cfg, plugin.instanceManager.get(cfg.id), vaultPath),
  );

  return {
    reporterId,
    vault: { vaultId, vaultName, vaultPath, instances },
    emittedAt: Date.now(),
  };
}

/**
 * Coarse relative timestamp for "Xm ago" lines — canonical implementation in
 * `../instance/instancePresentation` (takes an explicit "now" so it stays
 * deterministic in tests); re-exported at the top of this file.
 */

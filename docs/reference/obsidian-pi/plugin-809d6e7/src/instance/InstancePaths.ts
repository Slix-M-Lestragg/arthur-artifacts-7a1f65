/**
 * Path helpers for per-instance terminal resources.
 *
 * The "default" instance keeps legacy paths for backward compatibility:
 *   - sessions:  <vault>/<pluginDir>/sessions-terminal
 *   - prompt note: settings.promptNotePath (default "pi prompt.md")
 *
 * All other instances live in id-scoped subfolders/files:
 *   - sessions:  <vault>/<pluginDir>/sessions-terminal/<id>
 *   - prompt note: "pi prompt — <name>.md"
 */

import type ObsidianPiPlugin from '../main';
import type { PiInstanceConfig } from '../types';

export interface PluginBasePaths {
  vaultPath: string;
  pluginDir: string;
}

/** Resolve the vault path and plugin install directory. */
export function getPluginBasePaths(plugin: ObsidianPiPlugin): PluginBasePaths {
  const vaultPath = (plugin.app.vault.adapter as { basePath?: string }).basePath ?? '';
  const pluginDir = plugin.manifest.dir ?? '.obsidian/plugins/obsidian-pi';
  return { vaultPath, pluginDir };
}

/** Absolute sessions directory for an instance. */
export function instanceSessionsDir(
  plugin: ObsidianPiPlugin,
  instance: PiInstanceConfig,
): string {
  const path = require('path') as typeof import('path');
  const { vaultPath, pluginDir } = getPluginBasePaths(plugin);
  if (instance.id === 'default') {
    return path.join(vaultPath, pluginDir, 'sessions-terminal');
  }
  return path.join(vaultPath, pluginDir, 'sessions-terminal', instance.id);
}

/** Filename of the dedicated prompt note for an instance with the given
 *  display name. The note always follows the instance's name so renaming the
 *  instance renames the note (and vice versa). */
export function promptNoteFilename(name: string): string {
  return `pi prompt — ${name}.md`;
}

/**
 * Vault-relative prompt note path for an instance. Notes live in a HIDDEN
 * folder inside the plugin (`.obsidian/plugins/<id>/prompts/`) — out of the
 * file explorer — and are opened as MarkdownViews via a synthetic TFile injected
 * into vault.fileMap (see HiddenNoteRegistry). The path is derived from the
 * instance's display name (bi-directional: an instance rename renames the note,
 * a note rename renames the instance).
 */
export function instancePromptNotePath(
  plugin: ObsidianPiPlugin,
  instance: PiInstanceConfig,
): string {
  const dir = `${plugin.manifest.dir ?? '.obsidian/plugins/obsidian-pi'}/prompts`;
  return `${dir}/${promptNoteFilename(instance.name)}`;
}

/** Effective cwd for an instance — falls back to the vault root. */
export function instanceWorkingDir(
  plugin: ObsidianPiPlugin,
  instance: PiInstanceConfig,
): string {
  return instance.cwd || getPluginBasePaths(plugin).vaultPath;
}

/**
 * Resolve the absolute path to a loadable `node-pty` module folder for the
 * current platform.
 *
 * Obsidian's renderer `require` does not walk the plugin's `node_modules`, so
 * PtyClient requires node-pty by absolute path. We prefer, in order:
 *
 *   1. `<plugin>/node_modules/node-pty` — present when the user ran `npm install`
 *      or when the CI release workflow vendored it into the published `main`
 *      branch (see `.github/workflows/release.yml`).
 *   2. `<plugin>/vendor/node-pty-<platform>-<arch>` — a tracked, prebuilt,
 *      platform-specific copy (currently darwin-arm64). This makes a fresh
 *      clone of `dev` work out of the box with no `npm install`/build, even
 *      though `node_modules/` is gitignored and therefore absent.
 *   3. The `node_modules/node-pty` path from step 1 is returned as a last
 *      resort even when absent, so the original "npm install" error message
 *      from PtyClient stays accurate and discoverable.
 */
export function resolveNodePtyPath(plugin: ObsidianPiPlugin): string {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const { vaultPath, pluginDir } = getPluginBasePaths(plugin);
  const nmPath = path.join(vaultPath, pluginDir, 'node_modules', 'node-pty');
  if (fs.existsSync(nmPath)) return nmPath;

  // Fall back to a tracked, prebuilt, platform-specific vendored copy.
  const vendorPath = path.join(
    vaultPath,
    pluginDir,
    'vendor',
    `node-pty-${process.platform}-${process.arch}`,
  );
  if (fs.existsSync(vendorPath)) return vendorPath;

  // Nothing found — return the canonical path so PtyClient's error message
  // ("Ensure node-pty is installed in the plugin folder (npm install)") stays
  // accurate and points the user at the expected location.
  return nmPath;
}

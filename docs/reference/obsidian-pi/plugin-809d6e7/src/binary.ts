import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Platform } from 'obsidian';

// ─── Public API ────────────────────────────────────────────────────────────────

/** Resolved pi location and version. */
export interface BinaryInfo {
  /** Human-readable path shown in the settings UI. */
  path: string;
  /** Raw version string from `pi --version`, e.g. "0.79.6". */
  version: string;
  /**
   * When pi is a Node.js script (.js file), this is the node executable used to
   * run it.  Phase 2's subprocess spawner should use:
   *   nodeExe ? [nodeExe, path, ...args] : [path, ...args]
   */
  nodeExe?: string;
}

/** Thrown when pi cannot be located or executed, or the platform is unsupported. */
export class BinaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinaryError';
  }
}

/**
 * Locate a usable Node.js executable. Used to augment the subprocess PATH when
 * launching wrapper scripts (e.g. `sand-pi`'s run.sh) whose inner `pi` uses a
 * `#!/usr/bin/env node` shebang — Obsidian/Electron launches with a minimal
 * PATH that often excludes where `node` lives.
 * @throws {BinaryError} if no Node.js executable can be found.
 */
export async function findNodeExecutable(): Promise<string> {
  return findNode();
}

// ─── Detection constants ────────────────────────────────────────────────────────

/**
 * Relative path inside any npm global modules root to pi's CLI entry point.
 * pi is published as @earendil-works/pi-coding-agent; its binary is just
 * a thin Node.js script at dist/cli.js.
 */
const PI_CLI_REL = '@earendil-works/pi-coding-agent/dist/cli.js';

/**
 * Well-known global npm module roots, probed with fs.existsSync (no subprocess).
 * Covers Homebrew on Apple Silicon, Homebrew on Intel, Linux system npm,
 * and custom --prefix installs.
 */
const GLOBAL_MODULE_ROOTS: readonly string[] = [
  '/opt/homebrew/lib/node_modules',                                        // macOS Apple Silicon
  '/usr/local/lib/node_modules',                                           // macOS Intel / Linux
  '/usr/lib/node_modules',                                                 // Linux system npm
  path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),          // custom npm prefix
];

/**
 * Well-known node binary paths, tried in order before falling back to shell resolution.
 * /usr/local/bin/node is deliberately first: it is outside Homebrew's prefix and
 * therefore typically on the system PATH that Electron inherits.
 */
const NODE_CANDIDATES: readonly string[] = [
  '/usr/local/bin/node',          // system node (most macOS installs, Electron-accessible)
  '/opt/homebrew/bin/node',       // Homebrew Apple Silicon
  '/usr/bin/node',                // Linux
];

// ─── Main entry ────────────────────────────────────────────────────────────────

/**
 * Best-effort detection of the `fd` binary.
 *
 * `fd` is used by the @-file-reference suggester for fast, .gitignore-aware
 * filesystem traversal. It is optional: if not found, the suggester falls back
 * to a synchronous Node.js directory walk.
 */
export async function detectFdBinary(): Promise<string | null> {
  try {
    return await shellWhich('fd');
  } catch {
    return null;
  }
}

/**
 * Detect and validate the pi binary.
 *
 * When `overridePath` is set (non-empty string from plugin settings):
 *   - Expands `~` and resolves symlinks.
 *   - If the resolved file ends in `.js`, finds a node executable and runs
 *     `node <script> --version`.
 *   - Otherwise spawns the path directly.
 *
 * When `overridePath` is absent / empty (auto-detect):
 *   1. Probes GLOBAL_MODULE_ROOTS for `@earendil-works/pi-coding-agent/dist/cli.js`
 *      (fast, no subprocess needed).
 *   2. Falls back to login-shell `which pi` (handles custom PATH, nvm, etc.).
 *   3. Throws BinaryError with actionable instructions if nothing works.
 *
 * @throws {BinaryError} if platform is not desktop or pi cannot be run.
 */
export async function detectPiBinary(overridePath?: string): Promise<BinaryInfo> {
  if (!Platform.isDesktop) {
    throw new BinaryError(
      'obsidian-pi requires the Obsidian desktop app. Mobile and web are not supported.',
    );
  }

  const explicit = overridePath?.trim();
  if (explicit) {
    return resolveExplicit(explicit);
  }
  return autoDetect();
}

// ─── Explicit path resolution ───────────────────────────────────────────────────

async function resolveExplicit(givenPath: string): Promise<BinaryInfo> {
  const expanded = expandHome(givenPath);

  // Resolve symlinks so we can tell whether this is a .js script.
  let realPath = expanded;
  try {
    realPath = fs.realpathSync(expanded);
  } catch {
    // File may not exist yet — proceed; runVersion will give a clear error.
  }

  if (realPath.endsWith('.js')) {
    const nodeExe = await findNode();
    const version = await runScript(nodeExe, realPath);
    return { path: givenPath, version, nodeExe };
  }

  const version = await runBinary(expanded);
  return { path: givenPath, version };
}

// ─── Auto-detection ─────────────────────────────────────────────────────────────

async function autoDetect(): Promise<BinaryInfo> {
  // Step 1 — probe global npm module roots (no subprocess, instant).
  for (const root of GLOBAL_MODULE_ROOTS) {
    const cliPath = path.join(root, PI_CLI_REL);
    if (!fs.existsSync(cliPath)) continue;
    try {
      const nodeExe = await findNode();
      const version = await runScript(nodeExe, cliPath);
      return { path: cliPath, version, nodeExe };
    } catch {
      continue; // root exists but something failed; keep trying
    }
  }

  // Step 2 — ask a login shell where 'pi' lives (handles nvm, custom PATH, etc.).
  try {
    const shellPath = await shellWhich('pi');
    // Follow symlinks: if the shell found a symlink to a .js file, use the script directly.
    let realPath = shellPath;
    try { realPath = fs.realpathSync(shellPath); } catch { /* leave as-is */ }

    if (realPath.endsWith('.js')) {
      const nodeExe = await findNode();
      const version = await runScript(nodeExe, realPath);
      return { path: shellPath, version, nodeExe };
    }

    const version = await runBinary(shellPath);
    return { path: shellPath, version };
  } catch { /* fall through */ }

  throw new BinaryError(
    'Could not locate pi.\n' +
      'Install it with: npm install -g @earendil-works/pi-coding-agent\n' +
      'Or set the full path to your pi installation in plugin settings.',
  );
}

// ─── Node resolution ────────────────────────────────────────────────────────────

/**
 * Find the node executable, trying well-known paths first then shell resolution.
 * This is needed because Electron launches with a stripped PATH that omits
 * /opt/homebrew/bin and similar directories.
 */
async function findNode(): Promise<string> {
  for (const candidate of NODE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Shell fallback covers nvm, volta, fnm, custom installs.
  try {
    return await shellWhich('node');
  } catch { /* fall through */ }

  throw new BinaryError(
    'Could not find a Node.js executable to run pi.\n' +
      'Install Node.js (https://nodejs.org) or set node on your PATH.',
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Spawn `node <script> --version`. */
async function runScript(nodeExe: string, scriptPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(nodeExe, [scriptPath, '--version'], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new BinaryError(`Failed to run pi script with node: ${err.message}`));
        return;
      }
      resolve((stdout || stderr || '').trim());
    });
  });
}

/** Spawn `<binary> --version` directly. */
async function runBinary(binaryPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binaryPath, ['--version'], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) {
        reject(
          new BinaryError(
            `Failed to run pi at '${binaryPath}'.\n` +
              `Install pi or correct the path in plugin settings.\n` +
              `Details: ${err.message}`,
          ),
        );
        return;
      }
      resolve((stdout || stderr || '').trim());
    });
  });
}

/**
 * Use a login shell to resolve a command name to its absolute path.
 * A login shell sources ~/.zprofile / ~/.bash_profile so Homebrew, nvm, etc.
 * are on PATH — even though Electron launchers don't inherit them.
 */
async function shellWhich(name: string): Promise<string> {
  // `name` is interpolated into a `sh -lc` string — refuse anything that isn't
  // a plain command name so this can never become a shell-injection vector if
  // a future call site passes user-controlled input.
  if (!/^[\w.-]+$/.test(name)) {
    return Promise.reject(new Error(`Invalid command name: ${JSON.stringify(name)}`));
  }
  const shell =
    (['/bin/zsh', '/bin/bash', '/bin/sh'] as const).find((s) => fs.existsSync(s)) ?? '/bin/sh';
  return new Promise((resolve, reject) => {
    execFile(shell, ['-lc', `command -v ${name}`], { timeout: 5000 }, (err, stdout) => {
      const resolved = stdout.trim();
      if (err || !resolved) {
        reject(err ?? new Error(`'${name}' not found via ${shell}`));
      } else {
        resolve(resolved);
      }
    });
  });
}

import type { BinaryInfo } from '../binary';
import { findNodeExecutable } from '../binary';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Parse a shell-ish command string into `{ exe, args }`.
 *
 * Honors single and double quotes so paths with spaces work
 * (e.g. `"/Users/me/my pi/cli.js"`). No env expansion or escapes — this is a
 * minimal tokenizer for the "start command" setting, not a full shell parser.
 *
 * Returns `null` for an empty / whitespace-only string.
 */
export function parseCommandString(input: string): { exe: string; args: string[] } | null {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      hasToken = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true; // treat "" as an empty token
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (hasToken) { tokens.push(cur); cur = ''; hasToken = false; }
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(cur);
  if (tokens.length === 0) return null;
  const [exe, ...args] = tokens;
  if (!exe) return null;
  return { exe, args };
}

/** Path (relative to the home dir) of the default `sand-pi` sandbox launcher. */
const SAND_PI_DEFAULT_RUN = '.pi-sandboxes/default/run.sh';

/**
 * Resolve a start-command string to a concrete command:
 *  - `sand-pi`  → `~/.pi-sandboxes/default/run.sh` (the executable the zsh
 *    `sand-pi` function dispatches to; the function itself can't be spawned).
 *  - a leading `~/` is expanded to the home directory.
 * Anything else is returned unchanged (PATH-resolved commands need no expansion).
 */
export function resolveStartCommand(input: string): string {
  const cmd = input.trim();
  if (!cmd) return '';
  if (cmd === 'sand-pi') return path.join(os.homedir(), SAND_PI_DEFAULT_RUN);
  if (cmd === '~') return os.homedir();
  if (cmd.startsWith('~/')) return path.join(os.homedir(), cmd.slice(2));
  return cmd;
}

export interface StartArgv { exe: string; args: string[] }

/** Error thrown when neither a detected pi binary nor a start command is
 *  configured — shared verbatim by RpcClient, PtyClient and preparePiSpawn. */
export const NO_PI_BINARY_ERROR = 'No pi binary detected and no start command configured — set one in settings.';

/**
 * Resolve a start command into `{ exe, args }`, appending the plugin's standard
 * pi flags after the user's command. Throws a helpful `Error` if the command is
 * unparseable or points at a missing executable (so the caller surfaces it
 * instead of silently spawning the wrong binary).
 */
export function buildStartArgv(startCommand: string, piArgs: string[]): StartArgv {
  const resolved = resolveStartCommand(startCommand);
  const parsed = parseCommandString(resolved);
  if (!parsed) {
    throw new Error(`Invalid start command: ${JSON.stringify(startCommand)}`);
  }
  const exe = parsed.exe;
  if (exe.includes(path.sep) && !fs.existsSync(exe)) {
    const hint = startCommand.trim() === 'sand-pi'
      ? '\nNo sandbox found at ~/.pi-sandboxes/default/run.sh — create one (see the sand-pi README) or pick Custom…'
      : '';
    throw new Error(`Start command executable not found: ${exe}${hint}`);
  }
  return { exe, args: [...parsed.args, ...piArgs] };
}

/** Prepend the node executable's directory to PATH so `#!/usr/bin/env node` shebangs resolve. */
export async function ensureNodeOnPath(
  env: Record<string, string | undefined>,
  knownNodeExe?: string,
): Promise<void> {
  let nodeExe = knownNodeExe;
  if (!nodeExe) {
    try { nodeExe = await findNodeExecutable(); } catch { /* no node found */ return; }
  }
  if (!nodeExe) return;
  const dir = path.dirname(nodeExe);
  const cur = env.PATH ?? '';
  if (!cur.split(':').includes(dir)) {
    env.PATH = dir + (cur ? ':' + cur : '');
  }
}

export interface PiSpawnPlan { exe: string; args: string[]; env: Record<string, string | undefined> }

/**
 * Resolve an ad-hoc pi subcommand (e.g. `update`, `update --extensions`) into a
 * spawn plan { exe, args, env }, using the same launcher logic as the terminal
 * (start command or detected binary) and ensuring `node` is on the PATH.
 */
export async function preparePiSpawn(opts: {
  startCommand?: string;
  binaryInfo?: BinaryInfo;
  args: string[];
  env?: Record<string, string>;
}): Promise<PiSpawnPlan> {
  const { args } = opts;
  let exe: string;
  let fullArgs: string[];

  const cmd = opts.startCommand?.trim();
  if (cmd) {
    const plan = buildStartArgv(cmd, args); // throws if missing/invalid
    exe = plan.exe;
    fullArgs = plan.args; // already [...userArgs, ...args]
  } else if (opts.binaryInfo?.nodeExe) {
    exe = opts.binaryInfo.nodeExe;
    fullArgs = [opts.binaryInfo.path, ...args];
  } else if (opts.binaryInfo) {
    exe = opts.binaryInfo.path;
    fullArgs = args;
  } else {
    throw new Error(NO_PI_BINARY_ERROR);
  }

  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  await ensureNodeOnPath(env, opts.binaryInfo?.nodeExe);
  return { exe, args: fullArgs, env };
}

/**
 * If the start command resolves to a `~/.pi-sandboxes/<name>/run.sh` sandbox
 * launcher, return that sandbox directory; otherwise null. Used to run the
 * correct update command (npm) for sandbox-local pi installs, which `pi update`
 * cannot self-update.
 */
export function getSandboxDir(startCommand: string): string | null {
  const exe = resolveStartCommand(startCommand);
  if (!exe) return null;
  const m = exe.match(/^(.*\/\.pi-sandboxes\/[^/]+)\/run\.sh$/);
  return m ? m[1] : null;
}
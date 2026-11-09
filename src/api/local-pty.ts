/**
 * LocalPty — thin spawn wrapper around `@homebridge/node-pty-prebuilt-multiarch`
 * for the local pi terminal view. The plugin spawns a REAL `pi` process in a
 * local pty (one per terminal leaf) and pipes its output straight into xterm.js;
 * keystrokes/resize go the other way. No broker, no remote relay, no AHP
 * channel — the pty lives in the plugin process for the lifetime of the leaf.
 *
 * Native module resolution: `@homebridge/node-pty-prebuilt-multiarch` is an
 * esbuild `external` (see esbuild.config.mjs) — the built main.js `require`s
 * it at RUNTIME from the plugin dir's `node_modules`, it is NEVER bundled.
 * That means `npm install` must run wherever the plugin is BUILT/TESTED/RUN so
 * the native prebuild for the host Electron ABI is present (see
 * docs/LOCAL-PI-TERMINAL.md). The default factory below lazy-`require`s the
 * module ONLY on first spawn, so importing this file (or the bundle) never
 * touches the native binding — smoke tests inject a fake factory and never
 * load the real one.
 *
 * Testability: `spawnPi` takes an optional `factory` param. The default
 * factory is the real node-pty `spawn`; tests pass a fake that returns a
 * stub LocalPty so the data/resize/exit paths can be exercised with no native
 * pty and no real `pi` process.
 */

/** One end of a local pty — a subset of node-pty's IPty this view needs. */
export interface LocalPty {
	/** The OS pid of the spawned process. */
	readonly pid: number;
	/** Send bytes (keystrokes) to the pty's stdin. */
	write(data: string): void;
	/** Resize the pty to cols × rows. */
	resize(cols: number, rows: number): void;
	/** Subscribe to pty stdout/stderr output. Returns a disposable. */
	onData(cb: (data: string) => void): { dispose(): void };
	/** Subscribe to process exit. `exitCode` is the process exit code (0 on a
	 *  clean exit); `signal` is the terminating signal when killed by one. */
	onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
	/** Kill the process (and close the pty). Idempotent. */
	kill(signal?: string): void;
}

/** The spawn options the default factory passes through to node-pty. */
export interface PtySpawnOptions {
	/** pty terminfo name — fixed `xterm-256color` (matches xterm.js). */
	name?: string;
	/** Initial columns. */
	cols?: number;
	/** Initial rows. */
	rows?: number;
	/** Working directory the command starts in. */
	cwd?: string;
	/** Extra environment (merged over process.env by the default factory). */
	env?: Record<string, string>;
}

/**
 * Factory a pty from (command, args, options). The default implementation
 * lazy-`require`s `@homebridge/node-pty-prebuilt-multiarch` and calls its
 * `spawn`; tests inject a fake. The returned object must satisfy LocalPty.
 */
export type PtySpawnFn = (
	command: string,
	args: string[],
	options: PtySpawnOptions,
) => LocalPty;

/** Options for `spawnPi`. */
export interface SpawnPiOpts {
	/** Spawn a FRESH pi session (drop the `-c` resume flag). Default false —
	 *  resume the most recent session in `cwd` (mirrors pi-ahp-tty semantics). */
	fresh?: boolean;
	/** Initial viewport cols (default 80). */
	cols?: number;
	/** Initial viewport rows (default 24). */
	rows?: number;
	/** The pi executable (default `pi`; overridable via settings). */
	command?: string;
	/** Extra environment passthrough. */
	env?: Record<string, string>;
}

/** Default cols/rows when the view has no measured geometry yet. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * The default factory: lazy-`require` the native pty module on first use and
 * call its `spawn`. Never invoked at import time (smoke injects a fake before
 * any spawn), so a missing/incompatible prebuild never breaks the bundle load.
 */
const defaultPtySpawn: PtySpawnFn = (command, args, options) => {
	// Lazy require so the native binding only loads when a real terminal opens.
	// `require` here resolves at runtime to the plugin's node_modules (the
	// module is an esbuild external — never inlined into main.js).
	const pty = require("@homebridge/node-pty-prebuilt-multiarch");
	return pty.spawn(command, args, {
		name: options.name ?? "xterm-256color",
		cols: options.cols ?? DEFAULT_COLS,
		rows: options.rows ?? DEFAULT_ROWS,
		cwd: options.cwd,
		env: options.env ? { ...process.env, ...options.env } : process.env,
	}) as LocalPty;
};

/**
 * Spawn a local `pi` pty in `cwd`. Args default to `["-c"]` (resume the most
 * recent session in that cwd — mirrors pi-ahp-tty semantics); `opts.fresh`
 * drops the `-c` so a brand-new session starts. `opts.command` overrides the
 * executable (default `pi`). Pass a `factory` to inject a fake pty for tests.
 */
export function spawnPi(
	cwd: string,
	opts?: SpawnPiOpts,
	factory?: PtySpawnFn,
): LocalPty {
	const o = opts ?? {};
	const command = (o.command ?? "pi").trim() || "pi";
	// `-c` resumes the most recent session for the cwd; fresh → no flag.
	const args = o.fresh ? [] : ["-c"];
	const spawn: PtySpawnFn = factory ?? defaultPtySpawn;
	return spawn(command, args, {
		name: "xterm-256color",
		cols: o.cols ?? DEFAULT_COLS,
		rows: o.rows ?? DEFAULT_ROWS,
		cwd: cwd || undefined,
		env: o.env,
	});
}

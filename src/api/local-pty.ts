/**
 * LocalPty — thin spawn wrapper around `@homebridge/node-pty-prebuilt-multiarch`
 * for the local pi terminal view. The plugin spawns a REAL `pi` process in a
 * local pty (one per terminal leaf) and pipes its output straight into xterm.js;
 * keystrokes/resize go the other way. No broker, no remote relay, no AHP
 * channel — the pty lives in the plugin process for the lifetime of the leaf.
 *
 * Native module resolution: `@homebridge/node-pty-prebuilt-multiarch` is an
 * esbuild `external` (see esbuild.config.mjs) — the built main.js `require`s
 * it at RUNTIME, it is NEVER bundled. Obsidian loads main.js through
 * Electron's RENDERER require, which does NOT resolve bare specifiers
 * against the plugin folder's `node_modules` — so the default factory
 * resolves the module by ABSOLUTE PATH under the plugin's own `node_modules`
 * (built from `app.vault.adapter.getBasePath()` + `plugin.manifest.dir`),
 * then falls back to a bare `require` (works when main.js runs from a repo
 * checkout with node_modules — dev/smoke). That means `npm install` must run
 * wherever the plugin is BUILT/TESTED/RUN so the native prebuild for the host
 * Electron ABI is present (see docs/LOCAL-PI-TERMINAL.md). The default
 * factory lazy-loads the module ONLY on first spawn, so importing this file
 * (or the bundle) never touches the native binding — smoke tests inject a
 * fake factory and never load the real one.
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
	/** Absolute path to the native pty module folder, pre-resolved by the
	 *  caller from the vault base path + plugin manifest dir (see
	 *  `resolvePtyModulePath`). The default factory `require`s it directly —
	 *  Electron's renderer require needs an absolute path (bare specifiers
	 *  don't resolve against the plugin's node_modules there). Optional: when
	 *  absent the factory falls back to a bare require (dev/smoke). */
	ptyModulePath?: string;
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
	/** Absolute path to the native pty module (see `resolvePtyModulePath`).
	 *  Passed through to the default factory; ignored by injected fakes. */
	ptyModulePath?: string;
}

/** Default cols/rows when the view has no measured geometry yet. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Module id of the native pty dependency (an esbuild `external`). */
const PTY_MODULE_ID = "@homebridge/node-pty-prebuilt-multiarch";

/** Minimal shape of the loaded native pty module (its `spawn` matches PtySpawnFn). */
type PtyModule = { spawn: PtySpawnFn };

/**
 * Resolve the native pty module to an ABSOLUTE path under the plugin's own
 * `node_modules`. Obsidian loads main.js through Electron's RENDERER require,
 * which does NOT resolve bare specifiers against the plugin folder — it needs
 * an absolute path. `vaultBasePath` is the vault root (from
 * `app.vault.adapter.getBasePath()` — cast the adapter to `FileSystemAdapter`
 * via a typed structural cast); `manifestDir` is the plugin dir relative to
 * the vault root (from `plugin.manifest.dir`, typically
 * `.obsidian/plugins/arthur`). Returns the joined absolute folder path.
 */
export function resolvePtyModulePath(vaultBasePath: string, manifestDir: string): string {
	const base = (vaultBasePath || "").replace(/[\\/]+$/, "");
	const dir = (manifestDir || "").replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
	return [base, dir, "node_modules", PTY_MODULE_ID].filter(Boolean).join("/");
}

/**
 * Load the native pty module. Resolution order:
 *   1. `require(absPath)` — absolute path under the plugin's node_modules
 *      (Electron renderer require needs an absolute path; bare specifiers do
 *      NOT resolve against the plugin folder there).
 *   2. `require(PTY_MODULE_ID)` — bare fallback; works when main.js runs from
 *      a repo checkout with node_modules (dev/smoke).
 * The dynamic `require(absPath)` uses a non-literal argument so esbuild
 * leaves it untouched (it can't resolve it); the bare `require` stays a real
 * require because the module is an esbuild `external`. Throws a clear,
 * user-facing message on total failure (the view shows `.message`, no stack).
 */
function loadPtyModule(absPath?: string): PtyModule {
	if (absPath) {
		try {
			return require(absPath) as PtyModule;
		} catch {
			// absolute path missed (no node_modules / wrong layout) → try bare.
		}
	}
	try {
		// Bare literal require — esbuild matches this against its `external`
		// list and keeps it as a real runtime require (NOT bundled).
		return require("@homebridge/node-pty-prebuilt-multiarch") as PtyModule;
	} catch {
		// both paths failed — surface a clear message, not a stack dump.
	}
	throw new Error(
		"node-pty native module not found — run npm install in the plugin directory",
	);
}

/**
 * The default factory: lazy-load the native pty module on first use (via
 * `loadPtyModule`) and call its `spawn`. Never invoked at import time (smoke
 * injects a fake before any spawn), so a missing/incompatible prebuild never
 * breaks the bundle load.
 */
const defaultPtySpawn: PtySpawnFn = (command, args, options) => {
	const pty = loadPtyModule(options.ptyModulePath);
	const env = options.env ? { ...process.env, ...options.env } : process.env;
	return pty.spawn(command, args, {
		name: options.name ?? "xterm-256color",
		cols: options.cols ?? DEFAULT_COLS,
		rows: options.rows ?? DEFAULT_ROWS,
		cwd: options.cwd,
		// node-pty accepts the full process.env; the cast only satisfies our
		// narrower PtySpawnOptions.env type (ProcessEnv values may be undefined).
		env: env as Record<string, string>,
	});
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
		ptyModulePath: o.ptyModulePath,
	});
}

# Arthur — local pi terminal (pty-backed TUI)

- **Date:** 2026-11-08
- **Status:** ACTIVE (replaces the AHP `ahp-terminal:/<id>` plan in `PI-TERMINAL-PORT-PLAN.md`, which is SUPERSEDED)

## Architecture

The pi terminal view is a **local pty** rendered with xterm.js. Each open
terminal leaf owns its own pty — there is NO shared socket and NO AHP broker
relay. `src/api/local-pty.ts` exposes `spawnPi(cwd, opts?, factory?)`, a thin
wrapper over `@homebridge/node-pty-prebuilt-multiarch` that runs the configured
pi executable (default `pi`, overridable in Settings → Pi terminal) with
`["-c"]` to resume the most recent session in `cwd` (or no flag for a fresh
session). The pty uses `name: "xterm-256color"`, the leaf's cols/rows, the
given cwd, and env passthrough.

- `src/ui/terminal-manager.ts` — routes one leaf per cwd (`Map<cwd, leaf>`),
  reusing the existing leaf for an already-open cwd. Shared-nothing; each leaf
  spawns/kills its own pty. `ptyFactory` is settable so tests inject a fake.
- `src/ui/terminal-view.ts` — on attach spawns the local pty, pipes
  `pty.onData → xterm.write`, `xterm.onData → pty.write`,
  `ResizeObserver → fit → pty.resize`; on exit shows `process exited (code N)`
  and refuses further input. Lazy xterm construct, idempotent teardown.
- `src/ui/terminal-picker.ts` — LOCAL session/dir picker: scans
  `~/.pi/agent/sessions/` (one subdir per cwd; the authoritative cwd is read
  from the most-recent session jsonl's first `{"cwd":"…"}` line), plus a
  "New terminal in vault root" action and a cwd input row. Desktop-only — the
  command is hidden on mobile.

The AHP sessions view (`src/ui/ahp-view.ts`) and the `AhpClient` in
`src/api/ahp.ts` (read + controller surface, incl. the 819e2bb reconnect
cleanup-promise fix) are untouched.

## node-pty runtime resolution (important)

`@homebridge/node-pty-prebuilt-multiarch` is a **native** module and is listed
in `esbuild.config.mjs` `external` — the built `main.js` `require`s it at
**runtime** from the plugin dir's `node_modules`; it is **never bundled**.
Consequences:

- `npm install` must run wherever the plugin is **built/tested/run** so the
  native prebuild is present next to `main.js`.
- The default factory lazy-`require`s the module only on first spawn, so
  importing the bundle never loads the native binding (smoke tests inject a
  fake factory and never touch it).
- **Voyager (the Mac) prerequisite:** `pi` must be on the machine's PATH where
  the plugin runs (Settings → Pi terminal can override the executable). As of
  2026-11-08 `pi` is NOT installed on Voyager — terminals will fail to spawn
  (`pi spawn failed`) until it is.

### Electron ABI

The prebuilt-multiarch package ships prebuilds for several Node/Electron ABIs.
Obsidian pins `minAppVersion: 1.5.0` (≈ Electron 25.x). If the default prebuild
does not bind against the running Obsidian's Electron ABI, the standard
fallback is:

```sh
npm rebuild @homebridge/node-pty-prebuilt-multiarch \
  --runtime=electron --target=<obsidian-electron-version>
```

Detect Obsidian's Electron version via the developer console
(`window.require('electron').process.versions.electron`) or
`app.electronVersion` in the host. A rebuild requires the matching Electron
headers and a toolchain on the target machine.

## Release caveat (open issue)

The arthur release flow ships exactly five artifacts onto `main` (`main.js`,
`manifest.json`, `styles.css`, `versions.json`, `INSTALL.md`) — `node_modules`
is NOT carried. A native external module therefore does NOT bind from a stock
release install: the end user must run `npm install` (and possibly
`npm rebuild … --runtime=electron`) inside the plugin dir. This is an open
issue for a clean Brat/manual install path; tracked for a future fix (options:
a postinstall helper, a bundled prebuild per platform, or a documented
one-time `npm install` step in `INSTALL.md`).

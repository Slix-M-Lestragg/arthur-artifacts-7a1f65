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
session). The pty uses `name: "xterm-256color"`, the leaf's cols/rows, the given cwd,
and an **enriched PATH** (`buildSpawnEnv`, exported for smoke):
`dirname(realpath(piExecutable))` first — the nvm shim resolves to the real node bin dir, so pi's `#!/usr/bin/env node` shebang finds `node` even when the GUI app spawns with a minimal PATH —
then the inherited PATH, then `/opt/homebrew/bin`, `/usr/local/bin` and the newest `~/.nvm/versions/node/*/bin` appended only when they exist (no duplicates, empty entries dropped).

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

## Wave 1 — terminal foundation

On top of the local-pty backend, Wave 1 ports the obsidian-pi terminal-foundation feature set (adapted to our shared-nothing, RPC-free model — none of the reference AHP/RPC-coupled code is imported):

- **Instance states + tab/icon badges** (`src/ui/terminal-state.ts`, `src/ui/terminal-view.ts`): six visual states — `idle | running | done-unseen | seen | awaiting-input | error` — drive a CSS class (`arthur-pi-state-<state>`) on the state-line badge and the leaf's tab-header icon. `done-unseen` breathes (accent) until the leaf is focused; `awaiting-input` shows a red `?` badge while unfocused and clears on focus. States are derived from a **pragmatic, RPC-free heuristic** (the reference plugin uses pi RPC notify events we don't have): `computeActivityState` reads pty-data activity timestamps + xterm focus/blur — data within `ACTIVE_MS` (1200 ms) of the last chunk = `running`; data stopped > `IDLE_MS` (1500 ms) = `done-unseen`/`seen` by focus; a fresh pty with no data yet = `running`; `detectAwaitingInput` scans the last ~3 lines of each pty chunk for a trailing `?` (optionally + `[y/n]`/`[yes/no]`/`(y/n)`) or a bare yes/no hint; a non-question chunk after one clears it. Honest limitations: a `?` in agent prose at a line end can false-positive; a question_user prompt without a `?` can false-negative. A `STATE_TICK_MS` (500 ms) timer covers the quiet-agent transition.

- **Ribbon hub** (`src/ui/ribbon-hub.ts`): one "pi terminal" ribbon icon with a hover popover listing the open instances (state-colored dot + cwd); click a row to focus its leaf, "+ new" opens the session/dir picker. Simpler than the reference `RibbonInstanceHub` (no per-instance management menu — our instances are cwd-bound leaves), same spirit.

- **Instance picker when >0 terminals** (`src/ui/instance-picker.ts`, `main.ts openPiTerminalCommand`): the `open-pi-terminal` command now shows an `InstancePickerModal` (existing instances + "+ new…") when terminals are already open, and goes straight to the session/dir scanner when none are.

- **Session resume + restore-on-restart** (`src/api/local-pty.ts` `sessionFile`, `src/ui/terminal-picker.ts` `listSessionFilesForCwd`, `terminal-view.ts respawnWithSession`): picker rows now resume the EXACT session (`pi --session <abs file>`) instead of `-c`-newest; `LocalPiSession` carries the most-recent `.jsonl` path; the slash toolbar's "Resume…" lists every session file for the leaf's cwd (newest first) and respawns with `--session`. The leaf's `getState`/`setState` persist `sessionFile`, so on Obsidian restart the reopened leaf respawns the same session. `restoreTerminalLeaves` runs on `workspace.onLayoutReady` (when `piTerminalRestoreOnRestart` is on) to re-attach any cwd-bound leaf whose pty never spawned (deferred-leaf handling).

- **Slash toolbar** (`terminal-view.ts` state-line row): a compact "≡" icon-dropdown with New (`/new`), Resume… (per-cwd session files → `--session` respawn), Compact (`/compact`), Thinking (sends the Shift+Tab `\x1b[Z` cycle). Slash commands are `pty.write(cmd + '\r')`; Thinking is a bare escape (no `\r`).

- **Send active note / selection** (`src/ui/terminal-note.ts`, `main.ts sendActiveNoteToTerminal`/`sendSelectionToTerminal`): two `editorCallback` commands write into the most-recently-focused terminal leaf's pty. Note payload: `Here is the content of my note "<name>" (at <vaultAbsPath>):\n\n---\n<content with [[wikilinks]] rewritten to absolute paths>\n---\r`. Wikilinks (`[[Target]]`, `[[Target|Alias]]`, `[[Target#Section]]`, `[[Target#Section|Alias]]`) resolve to the target note's absolute vault path via `metadataCache.getFirstLinkpathDest` (unresolved links left verbatim); the `#section` anchor is preserved, the alias dropped. Selection sends just the (rewritten) selection + `\r`. A `Notice` tells the user to open a terminal first when none is focused.

- **Terminal settings** (settings tab "Pi terminal" section): `piTerminalFontFamily` (string, default `''`), `piTerminalFontSize` (number, default 13), `piTerminalScrollback` (number, default 5000), `piTerminalRestoreOnRestart` (bool, default true), plus the existing `piExecutable`. Wired into xterm `Terminal` options at construct time — changes apply to NEW terminals only (existing keep theirs; documented in each field's desc).

- **Theme-follow xterm styling** (`src/ui/terminal-theme.ts`): the xterm `ITheme` is derived from Obsidian CSS vars (`--background-primary` → background, `--text-normal` → foreground+cursor, `--interactive-accent` → selection) at construct and re-applied to every open terminal on `workspace.on('css-change')` (theme switch). Empty vars fall back to documented dark defaults.

Smoke coverage (sections 33–39): state transitions + badge CSS classes on focus/blur, toolbar slash payload bytes written to the pty (incl. Thinking's no-`\r` escape), resume spawn args (`pi --session <abs>`) + `listSessionFilesForCwd` + `respawnWithSession`, send-note payload shape (title + abs path + wikilink rewrite + trailing `\r` + unresolved-left-verbatim + no-terminal Notice), settings plumbing (`fontSize`/`scrollback` → xterm options on construct, new-only), theme var → `ITheme` mapping + fallbacks + `applyTheme` re-apply, instance picker + ribbon command routing. All existing sections remain green.

## Wave 2 — prompt surface (composer)

The docked prompt composer ports the reference plugin's prompt surface (its
`embedded` popout surface minus the popout/docked-window modes) as a plain
textarea strip at the **bottom of each terminal view** — deliberately WITHOUT
the APC submit marker: APC needs the obsidian-bridge pi extension, which arthur
doesn't install, so submission uses the **bracketed-paste path**:
`\x1b[200~<text>\x1b[201~` + a single trailing `\r` (the Enter lands after the
paste-end marker, so a newline inside the text can never submit mid-paste;
ESC bytes are stripped from the text first so embedded note content can't
break out of the paste and inject keystrokes — reference `PtyClient.
submitPromptViaPaste`).

- **Composer panel** (`src/ui/prompt-composer.ts`, mounted by
  `terminal-view.ts` after the xterm surface): drag resizer (min 72 px, clamped
  to `piTerminalComposerMaxHeight` % of the leaf with a hard 60% cap),
  multiline textarea, Mod+Enter submit / plain Enter newline (keystrokes in the
  composer never reach xterm), transient `✓ sent` flash, `hide` button plus a
  `⌨` toggle in the state line. Toolbar buttons (small lucide icons, text
  fallback): send, insert active note (content block, links rewritten), insert
  selection, insert a bare `[[…]]` token with the cursor between the brackets,
  and a word/char-count toggle.
- **Per-instance drafts**: in-memory on the `TerminalManager`, keyed by cwd
  (`getDraft`/`setDraft`) — written on every input, restored on leaf focus and
  on cwd change, cleared with the text when `piTerminalClearPromptOnSubmit` is
  on (default true); wiped on plugin unload (`closeAll`), never persisted.
- **Context rewriting on submit**: factored out of `terminal-note.ts` into
  `src/ui/link-rewrite.ts` (`rewriteContextLinks`) so both the send-note
  commands and the composer share it. Now also handles `![[image]]` embeds →
  bare absolute path; `#section` suffixes preserved, aliases (and the embed
  `!`) dropped, unresolved links verbatim. The composer's resolver is the same
  `metadataCache.getFirstLinkpathDest` + vault-base-path wiring as send-note.
- **@-file autocomplete** (`src/ui/at-suggester.ts`): `@` at a token boundary
  (space/tab/quote/`=` delimiters, incl. unclosed `@"quoted paths`) opens a
  fuzzy popup over the terminal's cwd — a **pure Node `fs` walk, no `fd`
  binary**: depth ≤ 4 levels, ≤ 2000 entries per walk, `.git`/`node_modules`
  skipped, top 50 scored (`MAX_WALK_*` / `MAX_SUGGESTIONS` exported). Files
  insert `@path/to/file`, directories insert `@dir/` for drilling; Esc
  dismisses, arrows + Enter/Tab select; the fs surface is injected (`FsDeps`)
  so smoke drives it over a fake tree.
- **Image paste passthrough**: a capture-phase `paste` listener on the xterm
  SURFACE — image-only clipboard → swallowed + `pty.write('\x16')` (Ctrl+V) so
  pi reads the OS clipboard itself (reference `TerminalView.bootTerminal`);
  text pastes fall through to xterm untouched. The composer textarea sits
  outside the surface, so composer pastes are unaffected.
- **Settings** (Settings → Pi terminal): `piTerminalPromptSubmitMode` — fixed
  to `paste`, documented, NO selector yet (APC needs the bridge extension) and
  any saved value is forced back on load; `piTerminalClearPromptOnSubmit`
  (bool, default true); `piTerminalComposerVisible` (bool, default true);
  `piTerminalComposerMaxHeight` (number, default 50, clamped 20–60).

Smoke coverage (section 40, 62 assertions): settings defaults + forced-paste
normalization + clamps, bottom-docked composer, per-instance draft
persist/restore, exact bracketed-paste byte sequence around multi-line text
with one trailing Enter, ESC-strip breakout guard, clear-on-submit on/off,
Mod+Enter vs plain Enter, all wikilink/embed rewrite cases, @-trigger
boundaries + fuzzy filtering + dir drilling + depth/entry caps over an injected
fake fs, image-paste gating (`\x16` vs untouched text paste), resizer clamp
math, and the hide/state-line toggle round-trip. All existing sections remain
green.

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

## Wave 3 — pi farm view (local sessions overview)

A READ-ONLY "pi farm" view merges the two local session realities into one
plain-DOM table, refreshed on a 5 s interval while open + on demand (Refresh
button):

- **Open instances** — from `TerminalManager.openInstances()`: every cwd-bound
  terminal leaf currently open, with its live Wave 1 activity state
  (`idle | running | done-unseen | seen | awaiting-input | error`) as the state
  dot and an `open` badge. Row action: **focus** the leaf.
- **Dormant sessions** — a scan of `~/.pi/agent/sessions/` reusing the
  terminal picker's `listLocalPiSessions` (no duplication — the same module),
  one entry per cwd (authoritative cwd read from the most-recent jsonl first
  line), newest `.jsonl` mtime + size. Row action: **resume** via the Wave 1
  path `pi --session <abs file>` (or `open` → `-c` newest when the subdir had
  no jsonl).

- **`src/ui/pi-farm-view.ts`** — `PiFarmView extends ItemView`, view type
  `arthur-pi-farm`, icon `tractor`, display "pi farm"; command "Open pi farm"
  (no ribbon). Lazy build on open, full teardown on close, `register`
  backstop for the refresh interval. `mergeFarmRows(open, dormant, now)` is a
  pure exported helper (keyed by trimmed cwd; a cwd that is BOTH open and
  dormant collapses to one open row carrying the dormant file/size; open rows
  bump mtime to `now` so live rows sort to the top; sorted modified-desc;
  capped at 200 rows). A compact/comfortable density toggle replaces the
  reference's 11-column/settings machinery.
- **`main.ts`** — `registerView` + the "Open pi farm" command +
  `activatePiFarmView` (right-leaf pattern); `onunload` detaches farm leaves;
  the terminal picker's new optional `onBrowseAll` opt is wired to open the
  farm, so the picker's empty state shows a "browse all sessions →" affordance.
- **Merge / dedup guarantee**: a dormant session whose cwd matches an
  already-open terminal renders as a single **open** row (focus action), never
  a duplicate spawn — consistent with the manager's leaf-reuse-by-cwd
  (`openTerminal(cwd)` focuses an existing leaf). Even a stale dormant row
  clicked after a leaf opened since the last refresh is safe: `openTerminal`
  focuses rather than spawns.
- **Read-only**: the scan stats session files but never writes — no
  delete/cull/rename this wave.

The `LocalPiSession` shape gained an optional `size` (bytes of the most-recent
jsonl), populated by `listLocalPiSessions` and ignored by the picker; the farm
view renders it in the size column.

Smoke coverage (section 41, ~30 assertions): exports + command registration,
pure merge semantics (shared-cwd collapse with file/size carried, distinct-cwd
two rows, open-only row, empty), 200-row cap keeping the most recent, view
lifecycle + table render against a fake sessions dir (cwd-slug decode
end-to-end), open-badge + focus vs resume action split, refresh interval
started-on-open / cleared-on-close, resume action spawning `pi --session <abs>`
through the fake pty factory, focus action reusing the existing leaf (no new
pty / no duplicate), empty-state note, the 200-row view cap, and the picker
empty-state "browse all sessions →" affordance firing `onBrowseAll` + closing
the picker. All existing sections remain green.

## Wave 4 — UI/UX fixes (typography, state hysteresis, inline toolbar, composer)

Four user-facing fixes against the live symptom set from the Mac (glyphs
rendering "very spaced out", tab badges flapping running↔done with no prompt
sent, the pi commands hidden behind a dropdown, a narrow short composer):

- **FIX A — xterm typography (root cause + cure).** xterm measures glyph
  widths with hidden DOM spans (`.xterm-char-measure-element`,
  `.xterm-width-cache-measure-container`) that JS styles only with
  font-family/font-size — `letter-spacing` is INHERITED from the surrounding
  Obsidian/theme CSS. Inherited tracking inflates the measured cell width,
  which xterm bakes back into the rows (`_setDefaultSpacing` → positive
  `letter-spacing` on `.xterm-rows`) — exactly the spaced-out glyph symptom.
  Cures: the Terminal is now constructed with an EXPLICIT resolved monospace
  chain (`resolveTerminalFontFamily` in `terminal-theme.ts`: user setting →
  Obsidian's `--font-monospace` read via `getComputedStyle` → fallback
  `Menlo, Consolas, monospace`), `letterSpacing: 0`, `lineHeight: 1`; a
  metrics guard in `styles.css` pins `letter-spacing: 0 !important` from
  `.arthur-pi-terminal` down through both measure elements (plus
  `line-height: 1; white-space: normal` on our container so no theme rule can
  leak into the surface); and the view re-`fit()`s once
  `document.fonts.ready` resolves (metrics measured before the font loads are
  stale). `resolveTerminalFontFamily` is pure + exported for smoke.
- **FIX B — state hysteresis** (`src/ui/terminal-state.ts`). The Wave-1
  heuristic (`ACTIVE_MS=1200`/`IDLE_MS=1500`) fought pi's ~1s spinner redraws:
  a gap >1200 ms read "done", the next spinner frame read "running", forever.
  Three rules now (pure, memory carried in an exported `ActivityMemory`
  advanced only by `syncActivityMemory` so view and smoke share one
  implementation):
  1. **Input gate** — done-unseen/seen is reachable ONLY after user input
     (`lastInputAt > 0`). A never-prompted session stays idle|running, never
     done/seen. (Chosen over a cumulative-bytes gate: a spinner accumulates
     bytes without bound, so bytes cannot distinguish "answered" from
     "still spinning". A real pty EXIT still shows done/seen/error — that's
     an event, not the heuristic.)
  2. **5 s true silence** — `DONE_SILENCE_MS = 5000` of NO data AND no input
     before the done/seen flip (every spinner frame resets it). `IDLE_MS`
     now only gates question freshness (awaiting-input detection UNCHANGED).
  3. **Re-arm** — a done stretch holds (`doneSince` + `bytesAtDone`
     snapshots) until fresh input lands after `doneSince` or ≥
     `DONE_REARM_BYTES` (2048) accumulates since it began; stray frames stay
     under the bar, so done never bounces to running on spinner noise.
- **FIX C — inline pi toolbar + ported icons.** The Wave-1 `≡` dropdown is
  gone: New / Resume… / Compact / Thinking are directly-visible icon buttons
  on the composer's toolbar row (the composer is that row's default-visible
  host), with the composer controls right-aligned after a spacer. The lucide
  glyph set is ported verbatim from the reference plugin and registered in
  `src/icons.ts` (`PI_ROW_ICONS`, with per-icon provenance):
  TerminalView toolbar → `layers` (Resume, its Session glyph), `gauge`
  (Thinking), `weight` (Compact); PromptPopout actionbar → `send`, `eraser`
  (clear — new button), `file-text` (note), `text-cursor-input` (selection),
  `square-slash` (command), `link` (wikilink), `bar-chart-3` (stats); `file-plus`
  for New (the reference's session panel uses text buttons — no reference
  icon). NOT ported: `mic` (needs an STT server we don't have),
  `hard-drive-download` (pull-from-TUI: no in-TUI editor bridge here),
  `image-plus` (reference opens a vault/dir/clipboard menu; our composer takes
  image pastes instead).
- **FIX C — local slash-command picker** (`src/ui/pi-commands.ts`). Reference
  `CommandPickerModal` UX (search box, ↑↓/↵/esc, `/<name>` inserted at the
  cursor) on a plain Obsidian `Modal`, but the LIST'S SOURCE OF TRUTH is
  deliberately LOCAL (we have no RPC): hardcoded builtin shortlist
  (`BUILTIN_PI_COMMANDS`: new/clone/compact/session/model/name/fork — the
  commands the reference itself drives) + `~/.pi/agent/prompts/*` → `/<stem>`
  + `~/.pi/agent/skills/*/` → `/<dir>`, deduped builtin-first, missing dirs
  degrade to builtins, fs surface injected (`FsDeps`) so smoke scans a fake
  `~/.pi` tree. Resume… keeps one popover (a file LIST has no inline form),
  anchored under its button.
- **FIX D — composer size/width.** The textarea is full width
  (`width: 100%` + `box-sizing: border-box`), font-sized by a new
  `promptFontSize` setting (default 16, clamped 10–32, applied at construct
  time to the element's style/class/`data-prompt-font-size` like the xterm
  font settings), and has NO line cap: `autoGrow()` grows the PANEL with the
  content (`scrollHeight` + toolbar chrome) up to the `piTerminalComposerMaxHeight`
  % of the view — grow-only, so a drag or an earlier taller content is never
  yanked back mid-typing. Buttons are an icon-only cluster pushed right by a
  flexible spacer (the pi commands sit left of it).

Smoke coverage: **section 33** now asserts the hysteresis directly (constants,
input gate — a never-prompted session never reaches done-unseen at any gap,
5 s silence boundary, re-arm by bytes/input, and three tick-loops through the
shared `computeActivityState`+`syncActivityMemory` pair: 1 s spinner ticks
over 30 s never leave running, sustained post-input silence flips to
done-unseen EXACTLY ONCE with the memory stamped, 40 stray frames stay done
until a ≥2 KB burst re-arms). **Section 34** asserts the inline row: exact
button order/ids (`pi-btn-*`), every ported lucide icon via the `setIcon`
stub, direct `/new` `/compact` `\x1b[Z` payloads (no dropdown), the Resume
popover open/close, `listPiCommands` over an injected fake `~/.pi` tree
(prompts/skills/builtins/dedupe/missing-dirs), and the picker modal
(open-from-row → row-click and filter+Enter both insert `/<name>`).
**Section 37** asserts the constructed Terminal carries `letterSpacing: 0`,
`lineHeight: 1`, the fallback chain, and the live `--font-monospace` read
(poisoned `getComputedStyle` stub) plus the pure resolver. **Section 42**
asserts `promptFontSize` default/clamps/construct-time application (class +
style + data attr, new-only), auto-grow clamping to the max-height % with
grow-only semantics, and the `styles.css` metrics/width guards. All existing
sections remain green (gate: `npm run typecheck && npm run build && npm run
smoke`).


## Wave 5a — composer full-size + top toolbar + 'ready' label

Three user-facing changes (the textarea STILL not taking full width/height,
sessions-management buttons belonging at the TOP, a fresh session showing
'running' instead of 'ready'):

- **Composer full-size restructure** (`src/ui/prompt-composer.ts`,
  `styles.css`). Diagnosis of the sizing failure: the textarea was a
  flex CHILD of the panel sharing the panel's fixed height with the button
  row — with `flex-wrap: wrap` on a 12-button toolbar, the wrapped rows ate
  the panel height and the textarea (`flex: 1 1 auto` + `min-height: 0`)
  collapsed into the leftover sliver. Cure — the panel is now
  resizer → **textarea BODY** → slim **footer strip**: the text element is
  `display: block; flex: 1 1 auto; min-height: 0; width: 100%;
  max-width: none; box-sizing: border-box` (it never shares a row with the
  buttons, so nothing can shrink/cap it), the footer strip is fixed chrome
  (`flex: 0 0 auto`) that can wrap freely without touching the body. The
  panel keeps `flex: 0 0 auto` + the drag/auto-grow clamp
  (`piTerminalComposerMaxHeight` %, hard 60% cap) so the xterm surface
  always keeps the remaining leaf space. `promptFontSize` still applies at
  construct time (inline style + `data-prompt-font-size`).
- **Top toolbar** (`src/ui/terminal-view.ts`). New / Resume… / Compact /
  Thinking moved OUT of the composer row onto the state-line row at the very
  TOP of the view: state dot+label at the left, the four pi command buttons
  (same Wave-4 lucide icons `file-plus`/`layers`/`weight`/`gauge`, same
  payloads — `/new\r`, `--session` respawn via the Resume popover,
  `/compact\r`, `\x1b[Z`) + the `⌨` composer toggle at the right. The Resume
  session-list popover is now anchored to the `position: relative` state
  line (`top: 100%`, inline left under its button) and drops over the
  terminal surface. The composer footer keeps send / clear / insert-note /
  insert-selection / slash-command picker / insert-link / stats / hide.
- **'ready' state label** (shared contract, shipped by the parallel Wave-5
  worker in `terminal-state.ts`): the pre-run state `idle` is renamed
  `ready` — a new/loaded session that hasn't run anything shows **ready**,
  NOT running (user input is the run boundary). The view resolves the
  pre-run name at RUNTIME off `ALL_TERMINAL_STATES` (`PRE_RUN_STATE`), maps
  BOTH generations to the badge label `ready`, and clears both
  `arthur-pi-state-idle` / `arthur-pi-state-ready` classes on badge swap —
  it compiles and behaves on either side of the rename.

Smoke coverage: **section 33** drives the contract vocabulary
(`PRE_RUN_STATE_NAME` / `FRESH_ALIVE_STATE_NAME` resolve the rename at
runtime — post-rename the fresh badge is asserted strict `ready`);
**section 34** splits its row-order/icon/payload assertions between the top
toolbar (the four command buttons, correct ids + reference icons + exact pty
bytes) and the composer footer (the eight remaining controls), and asserts
the Resume popover opens below the state line; **section 43** asserts the
composer DOM structure (resizer → textarea body → footer strip), the
construct-time promptFontSize on the textarea, the styles.css structure
guards (flex column panel, block-level flex textarea body with
width:100%/min-height:0, fixed footer chrome, surface keeps the remaining
space, state-line popover anchor, the is-ready class), and the 'ready'
label for a pre-run session (strict post-rename; the tolerant branch covers
the pre-rename vocabulary and the integrator removes it after integration).

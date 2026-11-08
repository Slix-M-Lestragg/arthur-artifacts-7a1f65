# Arthur — pi Terminal Views port plan (AHP 0.3.0)

- **Date:** 2026-11-08
- **Status:** PROPOSED (planning only — no plugin code implemented)
- **Scope:** Port the obsidian-pi terminal-view capability into the arthur Obsidian plugin as a **pure AHP remote client**. Resolves open decision **D2** from `docs/PI-AHP-INTEGRATION-PLAN.md` (xterm dependency).
- **Non-goal:** No in-plugin PTY. No `node-pty`. No broker changes. No arthur-agent changes in the first wave.

## 0. TL;DR

arthur already speaks the AHP 0.3.0 broker protocol (`src/api/ahp.ts`) with read + controller surfaces. The broker carries a `ahp-terminal:/<id>` channel per session: a PTY owner (the external `pi-ahp-tty` supervisor, or a future host-agent) registers the terminal externally and streams `terminal/data`; remote clients subscribe and send `terminal/input` + `terminal/resized`. This plan ports the **client half** — an `AhpTerminalAdapter` + a multi-leaf terminal ItemView rendered with **xterm.js** — so arthur can attach to and drive a real live pi TUI running on a remote device. The plugin never spawns a pty; it only renders and relays keystrokes over the existing authenticated, controller-gated WS.

## 1. Verified grounding

| Fact | Source | Relevance |
|---|---|---|
| AHP client: JSON-RPC WS, 0.3.0, `initialize.params.token`, per-channel `serverSeq` dedupe, reconnect cursor, `assertCanControl` gate | `src/api/ahp.ts` | The adapter extends this client; reuse its transport, dedupe, reconnect, roles |
| ItemView pattern, lazy connect on user action, onClose WS teardown | `src/ui/ahp-view.ts` | The terminal view mirrors this lifecycle |
| Broker terminal channel = `ahp-terminal:/<sessionId>`; actions `terminal/registerExternal {cols,rows}`, `terminal/data {data}`, `terminal/input {data}`, `terminal/resized {cols,rows}` | `~/.pi/agent/extensions/pi-ahp-client/src/pty-supervisor.ts` | Exact wire the adapter must speak |
| `hostAgent.*` (`terminalData`/`terminalResized`/`terminalExited`) is the PTY-**owner** side | `pty-supervisor.ts`, PI-AHP-INTEGRATION-PLAN §2.2 | arthur is the client side — never calls `hostAgent.*` |
| Stable session id `timestamp__slug(cwd)__uuid12`, coordinated via `AHP_SESSION_ID_OVERRIDE`+`AHP_LIVE_MODE=true` | `src/session-id-resolver.ts`, `pty-supervisor.ts` | Spawn/attach flow + fuzzy-picker dedup (TESTING #92) |
| arthur-agent tmux spawn: POST /api/pi/sessions `{device,cwd}` → `tmux new-session -d -s pi-arthur-<UTC> 'cd <cwd> && pi'` | `src/api/agent.ts` (`piSpawn`), AGENTS.md | Does NOT register a terminal channel — see §5 |
| `AhpSessionSummary` carries `hostAgentId`, `hostAgentName`, `hostOnline`, `terminalMode` | `src/api/ahp.ts` | How the picker detects attachable terminals |
| No xterm/pty dep today; esbuild externalizes electron/builtins only | `package.json`, `esbuild.config.mjs` | xterm.js bundles as a normal JS dep (not externalized) |
| Settings in `src/main.ts`: `ahpEndpoint`, `ahpToken`, `ahpEnableControl` (default off) | `src/main.ts` L60–157 | Add `ahpEnableTerminal` alongside |
| Test gate: `npm run typecheck && npm run build && npm run smoke` | `package.json`, PI-AHP-INTEGRATION-PLAN §2.4 | Reused; smoke gains mock-terminal suites |

## 2. Decision D2 — xterm.js dependency (RESOLVED)

**Recommendation: adopt `@xterm/xterm` + `@xterm/addon-fit` (+ optional `@xterm/addon-web-links`).** Reject lighter/hand-rolled alternatives and reject any in-plugin pty.

**Rationale:**
- pi's TUI (via `@earendil-works/pi-tui`) uses xterm-256color, mouse tracking, the Kitty keyboard protocol, alternate screen buffers, and truecolor. Only a real terminal emulator renders this correctly. A hand-rolled ANSI renderer would be high-effort, fragile, and visibly broken for the live TUI — unacceptable for a "real live pi" view.
- xterm.js is pure JS/TS, **no native modules**. It bundles cleanly under esbuild as a regular dependency (not externalized — it ships in `main.js`). This is the same engine obsidian-pi's `AhpTerminalAdapter` uses (proven reference, source on mac.home/Voyager, not on this server).
- **CSP / Electron:** xterm.js renders to a `<canvas>`/DOM, uses `requestAnimationFrame`, and performs no `eval`/`new Function`/remote fetch. It is compatible with Obsidian's renderer CSP. The `FitAddon` reads `ResizeObserver`/container metrics only.
- **Bundle impact:** ~150–200 KB gzipped added to `main.js`. Acceptable for a feature gated behind a view the user opens explicitly; the dep is tree-shaken into the single bundle arthur already ships.

**Why NOT node-pty in the plugin (key risk, flagged in the task):** `node-pty` is a native addon compiled against a specific Node/Electron ABI. Bundling it into an Obsidian plugin built with esbuild would require matching the exact Electron ABI of the user's Obsidian install, ship per-platform binaries, and break across macOS (Voyager)/Linux/Windows. **arthur stays a pure AHP remote client**: the pty is always owned externally (`pi-ahp-tty` on the device, or a future host-agent), exactly as obsidian-pi does. The plugin only subscribes + renders + relays.

**esbuild change:** add `"@xterm/xterm"`, `"@xterm/addon-fit"` (and `"@xterm/addon-web-links"` if adopted) as **regular** (non-external) imports; they bundle into `main.js`. No change to the `external` array. Import the xterm CSS (`@xterm/xterm/css/xterm.css`) — esbuild will inline it; otherwise import it in the view and ensure the CSS is present (Obsidian plugins load styles via `styles.css`, so either re-export xterm's CSS into `styles.css` at build time or import it from the JS entry — confirm during implementation; the cleanest path is a tiny `import "@xterm/xterm/css/xterm.css"` in the view module, which esbuild bundles).

## 3. Phases

### Phase T1 — Dependency + adapter skeleton (no UI yet)

**Goal:** land the xterm dep, an `AhpTerminalAdapter` that talks the terminal channel, and mock-WS smoke coverage — no user-facing view.

**Tasks**
1. Add deps: `npm i @xterm/xterm @xterm/addon-fit` (+ `@xterm/addon-web-links` optional). Verify `npm run build` bundles them into `main.js` with no external warnings; verify xterm CSS is present in the bundle.
2. New `src/api/ahp-terminal.ts` — `AhpTerminalAdapter`:
   - Constructed from an `AhpClient` (reuse its socket, roles, `dispatchAction`, `subscribe`/`unsubscribe`, per-channel `serverSeq` dedupe, reconnect cursor). Do **not** open a second socket.
   - `attachTerminal(sessionId: string, cols: number, rows: number, onData: (data: string) => void): Promise<void>` — `subscribe` to `ahp-terminal:/<sessionId>`, route inbound `terminal/data {data}` → `onData`, inbound `terminal/resized {cols,rows}` → a resize callback.
   - `sendInput(data: string): void` — `dispatchAction` NOTIFICATION `terminal/input {data}` on the terminal channel (controller-gated; see §6). Fire-and-forget, one frame.
   - `sendResize(cols, rows): void` — `dispatchAction` `terminal/resized {cols, rows}`.
   - `detach(): void` — fire-and-forget `unsubscribe` notification for the terminal channel; drop the channel's epoch-scoped watermark (mirror the detail-chat pattern in `ahp.ts`: drop watermark on deselect so a re-attach to the same idle terminal isn't wedged by the stale-watermark bug fixed in PI-AHP-INTEGRATION-PLAN §10b `ahp-resub-1`).
   - Reconnect: terminal channels are added to `AhpClient.activeChannels()` so the reconnect cursor carries them; snapshot-mode reconnect for a terminal channel re-applies via `acceptSnapshot` (terminal channels have no snapshot — expect `{}` and just re-subscribe if needed). Per-channel dedupe already absorbs over-replay.
   - Self-echo filtering: skip envelopes whose `origin.clientId === this.clientId` (the `AhpClient` does not do this generally; the adapter must, so local keystrokes aren't echoed back into xterm). Verify against `pty-supervisor.ts` which already filters `origin.clientId === this.clientId`.
3. Extend `AhpClient` minimally: expose a hook so the adapter can register a per-channel action handler for `terminal/*` actions (the current `handleEnvelope` routes only `session/*` and `chat/*`). Add a `registerChannelHandler(channel: string, fn: (action) => void)` / `unregisterChannelHandler` pair, OR route `terminal/*` through a new branch. Keep the existing per-channel `serverSeq` dedupe intact.
4. Smoke: extend `scripts/test-bundle.mjs` with a mock-terminal suite — subscribe a `ahp-terminal:/<id>` channel, assert `terminal/data` reaches `onData`, `sendInput` emits the exact `terminal/input` dispatchAction frame (no id, `origin.clientSeq` monotonic), `sendResize` emits `terminal/resized`, self-echo is filtered, detach sends `unsubscribe` and drops the watermark, reconnect restores the channel via the cursor without duplicating frames, and controller-gating blocks `sendInput` on a viewer connection.

**Acceptance**
- `npm run typecheck && npm run build && npm run smoke` green with the new mock-terminal suite.
- `main.js` contains the xterm bundle; no `node-pty` reference anywhere in `src/` or the bundle (grep-verified).
- No user-facing view yet; adapter is exercised only by smoke.

### Phase T2 — Terminal ItemView (single leaf)

**Goal:** a new view type `arthur-pi-terminal` rendering one attached terminal with xterm.js, following the `ahp-view.ts` ItemView lifecycle.

**Tasks**
1. New `src/ui/terminal-view.ts` — `TerminalView extends ItemView`:
   - `VIEW_TYPE_PI_TERMINAL = "arthur-pi-terminal"`; `getDisplayText()` = the session title or `pi terminal`; icon `terminal-square` (or `console`).
   - `onOpen`: build a container div; lazily create the `Terminal` (xterm) + `FitAddon` on first attach (not on open — mirror the lazy-connect rule from `ahp-view.ts`: an offline/blank endpoint must never open a malformed WS). Attach a `ResizeObserver` on the container → `fitAddon.fit()` → `adapter.sendResize(cols, rows)` (debounced).
   - Keystrokes: `terminal.onData(data => adapter.sendInput(data))` — raw keystrokes straight to the broker. xterm handles its own key decoding.
   - `onClose`: `adapter.detach()`, `terminal.dispose()`, clear `ResizeObserver`, null the `AhpClient` reference. Full cleanup (the `register()` belt-and-braces pattern from `ahp-view.ts`).
   - State line: connecting / live · 0.3.0 / error / closed, mirroring `ahp-view.ts`'s state line + the fail-closed protocol badge.
2. Register the view in `src/main.ts` (`registerView`) + an `addCommand` "Open pi terminal" that opens a leaf. Activation accepts a target `sessionId` (see §5).
3. CSS in `styles.css`: a `.arthur-pi-terminal` container sized to the leaf; ensure xterm's canvas fills it. Reuse `arthur-ahp-state`/`arthur-note` classes for the state line.
4. Smoke: view registration/open/close + xterm `Terminal` construction/dispose + WS cleanup (no live broker).

**Acceptance**
- Opening the view with a valid registered `sessionId` shows the live pi TUI; keystrokes appear in the real remote pty; resizing the Obsidian leaf resizes the remote pty.
- Closing the leaf disposes the xterm `Terminal` and unsubscribes the terminal channel; reopening re-attaches without duplicate frames.
- `npm run typecheck && npm run build && npm run smoke` green.

### Phase T3 — Multi-instance (InstanceManager-lite)

**Goal:** multiple concurrent terminal leaves, one per session, each with its own `AhpTerminalAdapter` sharing the single `AhpClient` connection (one socket, many channel subscriptions).

**Tasks**
1. New `src/ui/terminal-manager.ts` — `TerminalManager`:
   - Owns the shared `AhpClient` (lazily created on first terminal open; rebuilt on settings change like `ahp-view.ts`'s Refresh).
   - `openTerminal(sessionId: string, title?: string): WorkspaceLeaf` — reuse an existing leaf bound to that `sessionId` if present, else create a new leaf. Tracks `Map<sessionId, {leaf, adapter, terminal}>`.
   - `closeTerminal(sessionId)` — detach + dispose + forget.
   - `onUnload` / plugin `onunload`: close all adapters, dispose all xterm instances, close the shared client.
2. `TerminalView` becomes stateless about the connection: it asks `TerminalManager` for its adapter by `sessionId` (passed via the leaf state / view state).
3. Each adapter has its own per-channel `clientSeq` (already per-channel in `AhpClient`) and its own epoch-scoped watermark.

**Acceptance**
- Open 3 terminals for 3 sessions simultaneously; each renders independently; keystrokes go to the correct pty; no cross-channel leakage.
- Closing one leaf does not disturb the others or the shared socket.
- Smoke: a multi-leaf mock suite asserting independent channels + clean partial teardown.

### Phase T4 — Spawn + attach flow + fuzzy picker

**Goal:** the user can spawn a pi session and attach a terminal to it, and pick from already-running registered terminals.

**Tasks**
1. **Fuzzy terminal picker** (`src/ui/terminal-picker.ts`, or extend `pi-picker.ts`): lists AHP sessions from `AhpClient.catalogue()` filtered to those with a registered terminal (`summary.hostOnline === true` or `terminalMode` present / `hostAgentId` set). Fuzzy-match on title + workingDirectory. Selecting one calls `TerminalManager.openTerminal(resource)`.
   - Stable-id dedup (TESTING #92): the catalogue is keyed by `resource` (`ahp-session:/<id>`), so a resumed session appears once. Assert in smoke that two `listSessions` pages carrying the same `resource` produce one row.
2. **Spawn paths (document + wire):**
   - **Path A — tmux spawn (arthur-agent, already exists):** `piSpawn(device, cwd)` creates a tmux `pi` session but **does not** register an AHP terminal channel. After spawn, the session appears in the AHP catalogue (via the pi extension's live mirror) and the chat-detail view works, but **no terminal view is available** until a `pi-ahp-tty` process registers `ahp-terminal:/<id>` for that session. The plan documents this and offers a "spawn + open chat detail" fallback. A future arthur-agent enhancement could launch `pi-ahp-tty` on the device (out of scope here — flagged §8).
   - **Path B — pi-ahp-tty (external, registers terminal):** the user (or a future arthur-agent endpoint) runs `pi-ahp-tty --working-dir <cwd> [--fresh|--session <id>]` on the device. It spawns the pty, creates the AHP session with the stable id, registers the terminal channel, and sets `AHP_SESSION_ID_OVERRIDE`+`AHP_LIVE_MODE=true`. arthur's picker then shows it and `openTerminal` attaches. This is the path that yields a live terminal.
   - The plugin **never** runs `pi-ahp-tty` itself (it's a device-side node process with a `node-pty` dep — the same native-module risk).
3. **Attach to already-running:** the picker lists registered terminals; selecting attaches via Path B's registered channel. Re-attaching to a session already open in another leaf focuses that leaf (InstanceManager-lite dedup).
4. **Activation entry points:** add "Open pi terminal" command; add a terminal action on AHP view session cards (only when the card's `hostOnline`/`terminalMode` indicates a registered terminal); add a terminal action in `pi-panel.ts`'s opts-callback contract (mirror the open-AHP callback from PI-AHP-INTEGRATION-PLAN §4 Phase 1 wiring).

**Acceptance**
- Picker shows one row per registered terminal (TESTING #92 — no duplicates for a resumed session).
- Path B: a `pi-ahp-tty`-launched session is attachable and live; keystrokes reach the real pty (TESTING #89).
- Path A: a tmux-spawned session opens in chat-detail; the picker shows it but marks it "no terminal channel" and the terminal action is disabled with a tooltip explaining the requirement.
- Smoke: catalogue-filter + picker-render + dedup suite; spawn→catalogue→select state machine (mock).

### Phase T5 — Vault/note context features (scope split — mostly DEFER)

**Goal:** decide what rides this port vs later. Most obsidian-pi context features couple to the vault and are **deferred**.

| Feature | This port? | Rationale |
|---|---|---|
| Remote prompt injection (chat) | **Already shipped** (Phase 2 `prompt`) | arthur's controller `prompt()` on `ahp-chat:/` channels IS remote injection; gated by `ahpEnableControl` + controller role. No new work. |
| Remote "injection" (terminal) | **In scope (T1)** | `terminal/input` is the terminal analog; gated by `ahpEnableTerminal` + controller role (see §6). |
| Live title sync (`/name` → `session/titleChanged`) | **Render-only (in scope T2)** | The LiveMirror server-side extension dispatches `session/titleChanged`; arthur already merges `root/sessionSummaryChanged` and renders the title. TESTING #88 becomes a manual render check. arthur does NOT dispatch title changes for terminals (the pty owner does). |
| `VaultContext` (inject vault path into pi cwd) | **DEFER** | Couples plugin to the local vault; the pty runs remotely. Separate wave behind its own gate. |
| `sessionFiles` (note context injection) | **DEFER** | Same coupling; needs a broker/extension contract for note attachment. Separate wave. |
| Menubar / `sharp` image handling | **DEFER / out of scope** | Heavy native-ish deps; not terminal-core. |
| Swarm / farm-view parity | **DEFER** | Separate wave (PI-AHP-INTEGRATION-PLAN Phase 4). |

**Acceptance**
- Title sync: `/name` in the remote pi updates the arthur card title without a reconnect (manual — TESTING #88).
- Deferred items listed explicitly in §8 open questions.

### Phase T6 — Settings + security

**Tasks**
1. Add to `ArthurSettings` (`src/main.ts`): `ahpEnableTerminal: boolean` (default **false**) — the terminal-input gate. Keep `ahpEnableControl` as the chat-mutation gate; the two are independent (a user may want chat control but not terminal control, or vice-versa).
2. Settings tab: a toggle under the AHP section, with the same plaintext-token warning already present for `ahpToken`. Add a note: "Terminal input sends your keystrokes to the remote pi session. Requires a controller-role token."
3. **Security rules (carry forward from PI-AHP-INTEGRATION-PLAN §6):**
   - Token only ever in `initialize.params.token`; never in a URL, header, log, or error.
   - `terminal/input` and `terminal/resized` are mutations → gated by `assertCanControl("terminal/input")` (reuse the existing local gate) **AND** the new `ahpEnableTerminal` setting (both AND'd, fail-safe both ways — a viewer connection sends no keystrokes even if the setting is on).
   - Remote-control env gating (`AHP_LIVE_MIRROR_ALLOW_REMOTE_CONTROL`) is a **server-side** concern of the pty owner's LiveMirror; arthur is just a dispatching client. Document that the pty owner must opt in (TESTING #86) — arthur cannot enforce it.
   - No tokens in keystroke/error surfaces; `terminal/data` from the server is written to xterm only (never `innerHTML` — xterm is DOM-safe by construction).

**Acceptance**
- With `ahpEnableTerminal=false`, the terminal view renders read-only (no `onData`→`sendInput` wiring); with a viewer token, no `terminal/input` frame is ever sent (smoke-asserted).
- Settings persist and survive reload; token never appears in console/error toasts.

## 4. File-level touchpoints

| File | Change | Phase |
|---|---|---|
| `package.json` | add `@xterm/xterm`, `@xterm/addon-fit` (+ optional `@xterm/addon-web-links`) | T1 |
| `esbuild.config.mjs` | none to `external` (xterm bundles); confirm CSS inlining | T1 |
| `src/api/ahp-terminal.ts` | **new** — `AhpTerminalAdapter` | T1 |
| `src/api/ahp.ts` | minimal: per-channel `terminal/*` action handler hook; ensure `activeChannels()` includes terminal channels; reuse `dispatchAction`/`subscribe`/`unsubscribe`/reconnect cursor | T1 |
| `src/ui/terminal-view.ts` | **new** — `TerminalView extends ItemView` (xterm + FitAddon + ResizeObserver) | T2 |
| `src/ui/terminal-manager.ts` | **new** — `TerminalManager` (shared client, multi-leaf) | T3 |
| `src/ui/terminal-picker.ts` | **new** (or extend `pi-picker.ts`) — fuzzy picker over registered terminals | T4 |
| `src/main.ts` | register `arthur-pi-terminal` view + open command; add `ahpEnableTerminal` to `ArthurSettings`/`DEFAULT_SETTINGS`/`ArthurSettingTab`/`loadSettings` coercion | T2, T6 |
| `src/ui/ahp-view.ts` | add a "terminal" action on session cards when `hostOnline`/`terminalMode` indicates a registered terminal | T4 |
| `src/ui/pi-panel.ts` / `src/ui/dashboard-view.ts` | optional open-terminal opts-callback (mirror the open-AHP callback) | T4 |
| `styles.css` | `.arthur-pi-terminal` container + state-line reuse | T2 |
| `scripts/test-bundle.mjs` | mock-terminal suite (T1) + multi-leaf suite (T3) + picker/dedup suite (T4) | T1–T4 |

## 5. Spawn + attach flow (consolidated)

```
User action                 arthur plugin                 broker / device
─────────────                ────────────                  ───────────────
"New pi session"  ──► piSpawn(device,cwd) ──► arthur-agent tmux spawn (Path A)
                                              → pi runs in tmux, NO ahp-terminal channel
                                              → appears in AHP catalogue via live mirror
                                              → chat-detail works; terminal view unavailable

(device-side, external)
pi-ahp-tty --working-dir <cwd>            ──► spawns node-pty pi (TERM=xterm-256color)
                                              creates ahp-session:/<stable-id>
                                              dispatchAction terminal/registerExternal
                                              subscribe ahp-terminal:/<stable-id>
                                              pipes pty → terminal/data

"Open pi terminal" ──► TerminalPicker (catalogue filtered to hostOnline) ──►
                       TerminalManager.openTerminal(resource) ──►
                       AhpTerminalAdapter.attachTerminal(id, cols, rows)
                         subscribe ahp-terminal:/<id>
                         terminal/data → xterm.write
                         xterm.onData → dispatchAction terminal/input (controller-gated)
                         ResizeObserver → fit + terminal/resized
```

**Key invariant:** the plugin only ever subscribes + renders + relays. The pty lifecycle (spawn, register-external, resize-the-real-pty, exit) belongs to `pi-ahp-tty`/host-agent on the device.

## 6. Security notes (summary)

- Token in `initialize.params.token` only; never logged/errored.
- `terminal/input` + `terminal/resized` are mutations → `assertCanControl` + `ahpEnableTerminal` AND'd; viewer connections send no keystrokes (fail-safe both ways).
- Server-side remote-control opt-in (`AHP_LIVE_MIRROR_ALLOW_REMOTE_CONTROL`) is the pty owner's responsibility (TESTING #86); arthur documents it, cannot enforce it.
- `terminal/data` renders via xterm only (DOM-safe); server strings never become HTML.
- Plaintext token in vault `data.json` and plaintext tailnet WS remain existing realities — warn in settings UI, don't claim encryption.

## 7. Test strategy

**Automated gate (reused):** `npm run typecheck && npm run build && npm run smoke`.
- T1: mock-terminal suite — wire shapes, self-echo filter, dedupe, reconnect cursor, controller gating, detach watermark drop.
- T3: multi-leaf suite — independent channels, clean partial teardown.
- T4: catalogue-filter + dedup suite (TESTING #92 invariants), spawn→catalogue→select state machine.

**Manual scenarios (Voyager/mac — user pulls + tests remotely; no remote-coding assumptions):**
- **#89 (core):** `pi-ahp-tty` on a device → arthur attaches → live TUI renders → typed keystrokes appear in the real pty (not a separate process).
- **#92:** launch `pi-ahp-tty` twice in the same cwd (default resume) → picker shows ONE entry both times.
- **#88:** `/name` mid-session → arthur card title updates without reconnect.
- **#91:** a subagent session shows the `subagent` badge + parent linkage in the catalogue (already rendered by `sessionCard`); terminal attach to a subagent session works if it has a registered terminal.
- **#86:** with the pty owner's `AHP_LIVE_MIRROR_ALLOW_REMOTE_CONTROL=false`, arthur keystrokes are no-ops; with `=true`, they inject (verify the gate is server-side, arthur just surfaces the rejection).
- **node-pty native-module risk:** confirm `npm run build` produces a `main.js` with **zero** `node-pty` references (grep) and that the plugin loads on macOS Obsidian without any native-binary load. This is the headline platform-risk check.

**Honesty rule:** read-only terminal rendering is not a security boundary (same as PI-AHP-INTEGRATION-PLAN §4 Phase 1); controller gating is UX, the broker is the authority.

## 8. Out of scope + open questions

**Out of scope (this port):**
- Any in-plugin pty / `node-pty` bundling.
- Broker (pi-ahp-server) changes — terminal channels already exist in 0.3.0.
- arthur-agent changes (a future endpoint to launch `pi-ahp-tty` on a device is a separate proposal).
- `VaultContext`, `sessionFiles`, note-context injection (deferred wave).
- Menubar, `sharp` image handling, swarm/farm-view parity.
- 0.4 protocol convergence (PI-AHP-INTEGRATION-PLAN Phase 5 ADR).
- Archive terminal browsing (`listArchives` — no `archiveGet` in 0.3.0).

**Open questions (need user decision):**
1. **xterm addons:** adopt `@xterm/addon-web-links` (clickable URLs in TUI output) and `@xterm/addon-search` now, or keep the dep surface to `xterm`+`fit` only for the first cut? *Recommendation: ship `xterm`+`fit` only; add addons in a follow-up.*
2. **Spawn-path UX:** should the "New pi session" flow (Path A, tmux) offer to also kick off `pi-ahp-tty` on the device so a terminal view is immediately available? This requires an arthur-agent endpoint that does NOT exist today. *Recommendation: defer; document Path A as "chat-detail only" and Path B as "terminal-capable" in the picker.*
3. **Shared client vs per-view client:** should terminal views share one `AhpClient` with the `ahp-view` catalogue, or use a dedicated connection? *Recommendation: share one `AhpClient` (one socket, many channel subs) — simpler cleanup, matches the broker's one-client model. Confirm the `ahp-view` and terminal manager agree on a single owner.*
4. **Terminal channel in reconnect cursor:** the scalar `lastSeenServerSeq` is the MIN across active channels. A high-frequency `terminal/data` stream could drag the cursor for slower channels. *Recommendation: verify per-channel dedupe absorbs this (it does — the cursor is a per-channel cutoff, dedupe is per-channel); add a smoke test with mixed-frequency channels. No protocol change.*
5. **xterm CSS delivery:** import `@xterm/xterm/css/xterm.css` from JS (esbuild inlines) vs copy into `styles.css`. *Recommendation: JS import; verify the build includes it.*

## 9. Risks

- **R-T1 — node-pty creep:** any accidental import of `node-pty` (e.g. via a copied obsidian-pi module) breaks macOS. *Mitigation: grep-gate in smoke; the adapter is hand-written against `AhpClient`, not copied from pty-supervisor.*
- **R-T2 — xterm/Electron ABI:** xterm.js is pure JS so ABI is a non-issue, but an Obsidian CSP change or a future xterm version using `SharedArrayBuffer` could break rendering. *Mitigation: pin xterm to a known-good major; smoke-assert the `Terminal` constructs and disposes.*
- **R-T3 — stale-watermark re-attach wedge:** the `ahp-resub-1` bug (PI-AHP-INTEGRATION-PLAN §10b) class applies to terminal channels too. *Mitigation: epoch-scoped watermarks dropped on detach, exactly as detail chats do; smoke-test close→re-attach same terminal.*
- **R-T4 — Path A confusion:** users spawning via arthur-agent tmux expect a terminal and get "no terminal channel". *Mitigation: explicit picker affordance + tooltip; document Path A vs Path B in the plan and the eventual user docs.*
- **R-T5 — high-frequency `terminal/data` DOM pressure:** xterm handles high throughput, but a runaway pty could churn the renderer. *Mitigation: xterm's internal write buffering + the existing coalescing pattern; no cap on data (terminals must be lossless), but monitor.*
- **R-T6 — controller-role downgrade mid-session:** a reconnect that loses the controller role must disable `sendInput` live. *Mitigation: `controlSurface`-style re-evaluation on every state transition (mirror `ahp-view.ts`); smoke-assert viewer-after-controller sends zero input frames.*
- **R-T7 — macOS remote testing:** the user tests on Voyager; the plan avoids any remote-coding assumptions and keeps all automated checks in the local smoke gate. Manual scenarios are explicitly Voyager-side.

## 10. Immediate next actions

1. Approve D2 (xterm.js + addon-fit) and the scope split in §3/T5.
2. Land Phase T1 (dep + adapter + mock-terminal smoke) — no UI, fully gated.
3. Phase T2 (single terminal view) → manual #89/#92 on Voyager.
4. Phases T3–T6 in dependency order.
5. Open questions §8 (1–5) resolved before/within the phase they touch.

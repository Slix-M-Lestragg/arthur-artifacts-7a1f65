# obsidian-pi — Feature map (v0.4.0, post FIX SLICE H)

Complete feature/subfeature inventory from source of truth (`src/main.ts` onload, `types.ts` DEFAULT_SETTINGS, SettingsTab). Solidity grades from the 2026-09-01 audit: 🟢 solid · 🟡 adequate · 🔴 shaky · ⚫ vestigial/dead.

## A. Local pi terminal & instances 🟢
Interactive pi TUI (xterm.js over node-pty), multi-instance, desktop-only.

- **Interactive terminal view** (`'obsidian-pi-terminal-view'`, TerminalView.ts ~1721 lines)
  - Per-instance PTY processes, crash/restart recovery (PtyClient.ts ~826)
  - Sub-modes: local PTY · remote AHP · read-only subagent mirror · chat-mode
  - Toolbar: prompt button (⌘E), inline Session/Model/Settings panels, instance label, status, read-only badge
  - Session resume across restarts (`restoreSessionOnRestart`, per-instance session files) 🟡 *local-PTY resume untested*
  - Image paste → pi `pasteImage`
  - Canvas render (APC `render-canvas` → Electron capture, SVG fallback) 🟡
  - Right-click context menu: disconnect remote / change cwd / rename / settings
  - Numbered per-instance tab icons
- **Instance management** 🟢
  - Commands: `open-pi-terminal`, `add-pi-instance`, `remove-pi-instance`, `rename-pi-instance`, `reconnect-pi-terminal`, dynamic `open-pi-terminal-<instanceId>`
  - Ribbon icon (desktop → terminal; mobile → AHP opener) + hover ribbon instance hub (add/open/rename/change-dir/remove/settings)
  - Per-instance config: name, cwd, model, agentDir, thinking level
  - Instance stats (tokens/cost/model tooltips)
- **Maintenance** 🟢: `check-pi-binary`, `pi-update`, `pi-update-extensions`, `pi-update-all` (streaming PiCommandModal); binary detection, `sand-pi` sandbox wrapper via `startCommand`

## B. Prompt composer 🟡
Markdown-note prompt editor, 3 surfaces: floating popout OS window / docked leaf / embedded panel in terminal (PromptPopout.ts ~2172, zero unit tests).

- Commands: `open-pi-prompt-popout`, `dock-pi-prompt`, `toggle-pi-prompt-surface`, `submit-pi-prompt` (⌘Enter)
- Wikilink rewrite → abs paths; `[[`, `/command`, `@file` suggesters 🟡 *untested, optional `fd` dep*
- Submit via APC or paste (`promptSubmitMode`); image attach via clipboard→temp-file `@path`
- Prompt note ↔ instance name bi-directional rename sync; hidden prompt notes (`pi prompt — <name>.md`, CSS-hidden)
- Voice dictation mic button (→ F); word/char stats; always-on-top; auto-open on load; clear-on-submit

## C. AHP remote sessions 🟡
WebSocket JSON-RPC 0.3.0 client to the AHP broker (AhpClient.ts ~1200; works on mobile).

- Commands: `ahp-open-or-create-session`, `open-farm-view`, `dispatch-task-to-worker`
- Session catalogue browser (AhpSessionBrowserModal: live/archived, search, new session) 🟡
- Interactive remote terminal (PTY-over-WS + snapshot replay; AhpTerminalAdapter) 🟡
- Prefer-local routing (FIX SLICE H): own-device `ext-<device>-<instanceId>` rows open the LOCAL PTY with session resume from every surface (`openLocalRelaySessionIfLocal`, first check in `openAhpTerminalForSession`); `transport/localRelay.ts` is the shared pure matcher
- Session browser `local` badge on own-device external rows (URI match)
- Hosted session create/dispose (`newHostedAhpSession`) 🟡
- Read-only subagent mirrors (scheme-swap `ahp-uri.ts`)
- Live chat/action stream → notifications (AhpActionMapper)
- Wire bugs from AUDIT §1.1 fixed: reconnect re-subscribes terminal channels and applies session-chat snapshots; the shared client is no longer disposed on create failure
- Shared status/presentation modules: `transport/ahpStatus.ts` (single bitmask decoder) + `instance/instancePresentation.ts` (`formatAgo`/`formatTokens`/row projection); `AhpSessionPickerModal` now hosts only the live-mirror confirm flow + helpers used by the browser modal

## D. Farm View + host-agent relay 🟡
- **Farm View** (`'farm-view'`, FarmView.ts ~1581): catalogue table — bitmask statuses, filters/search/sort, density, column visibility, group-by-project, live updates, external/local toggles, per-row actions (open/archive/dispatch); Open is a pure delegation to `openAhpTerminalForSession` (prefer-local + offline gates live plugin-side since FIX SLICE H). Settings pushed to server: provider concurrency caps, cost alert threshold, auto-cull idle minutes. 🟡 many settings UI-only (`tags`, `pollIntervalMs`, `showMirrors`…)
- **Host-agent relay** (HostAgentClient.ts 580) 🟢: registers local instances as `kind:"external"` sessions; full-state `syncInstances`; terminal stream relay (startTerminalStream/data/resize/input/exit); heartbeat 15s; desktop opt-in (`hostAgentEnabled`, `hostAgentDeviceName`)
- **Swarm dispatch** (swarmDispatch.ts ~348) 🟡: headless `pi -p` task → worker host; DispatchResultModal; ⚫ undocumented

## E. Headless, vault & editor integration 🟡
- **Headless JSON mode** (JsonRunner, ⚫ untested): frontmatter `pi-trigger`, ```` ```pi ```` codeblock Run button + JSON prompt spec, one-shot `run-pi-prompt` modal; HeadlessResultModal (copy/save/apply-output/rerun-with-variation); commands `run-pi-trigger`, `run-pi-codeblock`
- **Vault context** 🟢: `send-active-note`, `send-selection` (wikilink resolution), apply-output to note
- **Bridge extension** (extensions/obsidian-bridge.ts 786, shipped as loose TS) 🟡: APC submit/notify/get-text/answer protocol; dual render_canvas implementation (src/canvas/renderCanvasTool.ts never called in prod — inlined copy instead) = drift risk
- **Notifications** (AgentNotifier) 🟢: agent events (start/end/error/abort/question/session_start) → Notice / OS native / both; sound; focus-only suppression; interactive macOS reply buttons → `pi:answer:` APC routing

## F. Peripheral / platform 🔴
- **macOS menubar tray** 🔴 (`menubarEnabled`, default off): cross-vault leader election over Unix socket (single tray for all vaults), instance menu grouped by vault with click routing, idle filter, 3 icon styles + live thumbnail picker, accent-color observer. Coordinator/MenubarIpc untested; `menubar-registry.js` loose CJS via `@electron/remote` — now copied by release.yml. Command: `debug-menubar` [debug]
- **STT voice dictation** 🔴: streaming Whisper sidecar (MicStreamer, stt-stream.ts) + dead batch path (MicRecorder/transcribe unreferenced); spectrum meter; auto-submit; no tests/docs; server URL defaults to empty (empty = not configured) and tokens support env override (`STT_TOKEN`). Settings: sttServerUrl/sttToken/sttLanguage/sttModel/sttAutoSubmit
- **Auth bridge** 🟡 (bridge/auth-bridge.mjs subprocess, ref-counted): Provider panel (auth status, keys, OAuthLoginModal), ModelBrowserModal, SettingsBridgeModal (pi settings.json), TerminalView inline Model/Settings panels. Requires npm-global Node-script pi — dead with compiled binaries
- Debug commands in production palette: `debug-menubar`, `test-question-notification`

## G. Vestigial local RPC surface ⚫ (narrowed in FIX SLICE G)
RpcClient subprocess (394 lines, `pi --mode rpc`) still spawned on desktop load; its only live consumer is `/command` autocomplete (`CommandSuggester`/`CommandPickerModal` via `get_commands()`). FIX SLICE G stripped the dead chat era:
- Removed the ~28 zero-caller command methods (`steer`/`fork`/`clone`/`compact`/model+thinking cycling/session stats/…) from `RpcClient`, `AhpClient` and the shared `PiClient` interface; `types/rpc.ts` `RpcCommand` union narrowed to `prompt` + `get_commands`; `RpcSessionState`/`RpcSessionStats`/`RpcModel`/extension-UI types deleted.
- **Deleted `ExtensionUiHandler`** + its Select/Confirm/Input/Editor modals (445 lines): pi's `obsidian-bridge` extension never triggers the RPC extension-UI sub-protocol in the terminal-based flow — it handles dialogs/answers via APC markers (`pi:answer:`) instead. `extension_ui_request` lines now fall through as unhandled events.
- `connectRpc` racing-connect dedup fixed earlier via `SubprocessLifecycle` (shared with `PtyClient`): concurrent `connect()` callers join the same in-flight spawn.
- ⚫ `defaultChatMode: 'chat'` setting — read nowhere (candidate for removal with a migration shim)

## Settings tab structure (5 tabs)
- **General**: pi Binary (desktop) · Remote AHP server · Host agent (desktop) · Agent (model/thinking/agentDir) · Sessions (restore) · Agent notifications (mode/sound/focus/interactive-macOS) · Menu bar (macOS)
- **Terminal**: instance cards (name/cwd/model/agentDir/remove) · default chat mode ⚫ · fonts/scrollback · prompt fields (submit mode, surface, popout size, clear-on-submit, hide note, open-on-load)
- **Auth & Providers**: auth strategy · providers & auth · model browser · pi settings.json · ANTHROPIC_API_KEY (runtime-key only)
- **Farm View**: sort/density/columns · live updates · cost alert · auto-cull · group-by-project · always-show devices · provider caps
- **Prompt & Voice**: STT server/token/language/model/auto-submit

Deprecated/code-only settings: `vaultAsCwd`, `promptNotePath`, `lastSessionFile`, `promptAlwaysOnTop`, `promptStatsEnabled`, several `farmView.*` code-only keys.

## Transport capability matrix
| Transport | Enables | Gate |
|---|---|---|
| Local PTY (node-pty) | interactive TUI, prompt submit, image paste, canvas render, session resume | desktop |
| Local RPC (JSONL) | slash-command autocomplete only (`get_commands`) | desktop (vestigial; UI/dialog sub-protocol removed) |
| AHP WebSocket | remote catalogue, remote terminals, hosted sessions, subagent mirrors, Farm View, swarm dispatch, archive browse | any platform |
| Host-agent relay | publishes local instances to farm, relays terminal streams for remote attach | desktop + opt-in |

## Totals
~7 clusters · 21 static + N per-instance commands · ~60 settings fields · 2 registered views + 3 prompt surfaces · 11 modal classes (0 dead) · 4 transports · 29 test suites / 425 tests
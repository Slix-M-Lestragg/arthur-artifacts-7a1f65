# obsidian-pi Technical

> **Where to look**
> - **docs/FEATURES.md** — the authoritative feature/surface inventory (cluster by cluster, with solidity grades).
> - **docs/AUDIT-2026-09-01.md** — the 2026-09-01 audit findings (wire-contract bugs, dead code, docs drift).
> - This document explains the architecture and the protocol-level details; it was rewritten to match the
>   post-ChatView codebase (0.4.0) and updated through FIX SLICE G (RPC remnant stripping + consistency pass).

## Overview

`obsidian-pi` is an **Obsidian plugin** that embeds the [pi coding agent](https://pi.dev)
inside the vault, giving the user full agent control and deep two-way integration with
notes.

It runs on **desktop and mobile** (`manifest.json` sets `"isDesktopOnly": false`). The
transports it can use differ by platform — see the table below and
[Platform support](#platform-support).

The plugin talks to pi (and to the surrounding infrastructure) through **five transports**:

| # | Transport | Command / mechanism | Use in plugin | Platform |
|---|---|---|---|---|
| 1 | **Local PTY** | `node-pty` + interactive `pi` TUI | The interactive terminal view (`xterm.js`), one `PtyClient` per instance; prompt popout composer; image paste; canvas render; session resume. | Desktop only |
| 2 | **Local RPC** (vestigial) | `pi --mode rpc`, JSONL over stdin/stdout | **Not a chat surface anymore.** Only live consumer: `/command` autocomplete (`CommandSuggester`/`CommandPickerModal` via `get_commands()`). The chat-era command methods, the `ChatView`/`SessionPanel` UI and the `ExtensionUiHandler` dialog bridge have all been deleted (FIX SLICE G). | Desktop only |
| 3 | **AHP WebSocket** | JSON-RPC 0.3.0 over WebSocket to the AHP broker | Remote sessions (interactive PTY-over-WS terminals), hosted session create/dispose, Farm View catalogue, read-only subagent mirrors, swarm dispatch (`pi -p` to worker hosts), archive browsing. | Desktop **and mobile** |
| 4 | **Host-agent relay** | `HostAgentClient` → broker | Publishes local instances to the farm as `kind:"external"` sessions (`syncInstances` full-state contract) and relays terminal streams (`startTerminalStream`/`data`/`resize`/`input`/`exit`) so remote clients can attach to them. Heartbeat every 15 s. | Desktop, opt-in (`hostAgentEnabled`) |
| 5 | **APC tunnel** | `ESC _ pi:... ESC \` marker protocol over the terminal stream | The `obsidian-bridge` pi extension and the plugin exchange structured requests across the raw TUI stream: prompt submission (`pi:prompt:`), notification answer routing (`pi:answer:`), canvas render (`pi:render-canvas:`/`-result:`), get-text, notify. | Any platform with a terminal surface (local PTY **or** AHP terminal) |

The former fourth row of this table — the "SDK bridge" — has shipped and is no longer a
transport in the same sense; see [SDK auth bridge (shipped)](#sdk-auth-bridge-shipped).

Docs for the pi-side protocols: SDK `docs/sdk.md`, RPC `docs/rpc.md`, JSON `docs/json.md`.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Obsidian (Electron renderer on desktop; mobile app on phones/tablets)     │
│                                                                            │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐ ┌──────────────────┐  │
│  │ TerminalView │ │ PromptPopout │ │  FarmView     │ │ SettingsTab      │  │
│  │ (xterm.js,   │ │ (floating /  │ │ (farm         │ │ + Provider/Model │  │
│  │  per-inst.)  │ │  docked /    │ │  catalogue)   │ │ /Settings/OAuth  │  │
│  │              │ │  embedded)   │ │               │ │ panels           │  │
│  └──────┬───────┘ └──────┬───────┘ └──────┬────────┘ └────────┬─────────┘  │
│         │                │                │                   │            │
│  ┌──────▼────────────────▼────────────────▼───────────────────▼─────────┐  │
│  │  main.ts — ObsidianPiPlugin                                          │  │
│  │  settings · binaryInfo · instanceManager · ahpClient (shared)        │  │
│  │  hostAgentClient · authBridge · agentNotifier · vaultContext         │  │
│  └──┬───────────┬──────────────┬──────────────┬───────────────┬─────────┘  │
│     │           │              │              │               │            │
│     ▼           ▼              ▼              ▼               ▼            │
│  InstanceMgr  RpcClient      AhpClient    HostAgentClient  AuthBridge     │
│  (per-inst.   (vestigial:    (remote      (publishes       (ref-counted   │
│   PiInstance:  autocomplete  sessions,    local insts      subprocess     │
│   PtyClient +  only)         terminals,   to farm,         client)        │
│   TerminalView)              mirrors,     relays streams)                │
│   + PromptPopout)            swarm)                                      │
│     │                          ▲                                          │
│     │                          │ WebSocket                                │
└─────┼──────────────────────────┼──────────────────────────────────────────┘
      ▼                          ▼
 child_process:               pi-ahp-server broker (ws://…:4500)
 node dist/cli.js (local PTY / vestigial RPC / JSON mode)
      │
      ▼
 APC markers ⇄ extensions/obsidian-bridge.ts (shipped as raw TS, loaded by pi)
```

**Deleted generations.** The RPC/ChatView era (a sidebar `ChatView` with streaming
`message_update` rendering, and the inline `SessionPanel` with its session/model/action
modals) has been fully removed from `src/`. FIX SLICE G additionally stripped the dead
command surface: ~28 zero-caller methods (`steer`/`fork`/`clone`/`compact`/model
cycling/session stats/…) were removed from `RpcClient`, `AhpClient` and the shared
`PiClient` interface, and `transport/ExtensionUiHandler.ts` (dialog modals for the RPC
extension-UI sub-protocol) was deleted — the `obsidian-bridge` extension handles
dialogs/answers via APC markers, so the RPC UI sub-protocol was never exercised.
`extension_ui_request` lines now fall through as unhandled events. The `RpcClient`
subprocess survives only as the provider of `/command` autocomplete (`get_commands`)
plus `prompt` on the shared interface (used by the AHP chat-mode adapter). There is
**no** DOM chat surface: interactive work happens in the per-instance terminal view,
with the prompt-note popout as the rich composer (see `FEATURES.md` §G).

### Notice conventions

Three user-facing Notice tiers (unified in FIX SLICE G):
1. **`obsidian-pi: …`** — plugin-level capability/environment notices (desktop-only /
   mobile guards, menubar debug output).
2. **Subsystem lead token** — operational notices lead with their subsystem: `pi RPC …`
   / `pi agent …` (local RPC client), `AHP …` (remote sessions, terminals, hosted
   sessions, host-agent relay), `Farm view …`, `Auth bridge …`.
3. **Status glyphs** — `✓` success / `⏳` in-progress / `❌` failure prefixes on top of
   the subsystem lead, e.g. `✓ AHP interactive terminal: ahp-terminal:/…`,
   `AHP: no interactive terminal on this server`.

Error text surfaced in notices is normalized through the shared
`utils/errors.ts#errorMessage()` helper (replacing ~60 inlined
`err instanceof Error ? … : String(err)` copies; applied at the highest-traffic sites
in `main.ts` and `FarmView.ts`).

### Core modules

| Module | Responsibility |
|---|---|
| **main.ts** — `ObsidianPiPlugin` | Plugin entry; owns settings, binaryInfo, instanceManager, the shared ahpClient, hostAgentClient, authBridge, rpcClient, vaultContext, agentNotifier. Registers views, commands, ribbon (terminal ribbon on desktop, AHP opener on mobile), dynamic per-instance commands. |
| **binary.ts** — `detectPiBinary()` | npm global probe → node resolution → `pi --version` health check. Returns `BinaryInfo { path, version, nodeExe? }`. |
| **instance/InstanceManager.ts** | Owns one `PiInstance` per configured terminal instance; resolves per-instance cwd/agentDir/model/thinkingLevel; creates/destroys `PtyClient`, wires state notices, records session files, restarts sessions with `--session <path>`. |
| **instance/instancePresentation.ts** | Shared instance-row presentation (`formatAgo`, `formatTokens`, cost formatting) — previously duplicated across menubar snapshot, ribbon hub and Farm View. |
| **instance/InstancePaths.ts** | `instanceSessionsDir()`, `instancePromptNotePath()`, `instanceWorkingDir()` — per-instance paths for session directories, prompt notes, and effective cwd. |
| **transport/PtyClient.ts** | `node-pty`-backed subprocess for the real interactive `pi` TUI **per instance**; ANSI stream piped to `xterm.js`; APC-marker/bracketed-paste prompt submission bridge; notify events include `instanceId` and `sessionFile`. |
| **views/TerminalView.ts** | Sidebar `ItemView` hosting `xterm.js` (+ fit/search/web-links addons) over either the per-instance local `PtyClient` or an AHP remote terminal; toolbar shows instance name + cwd basename; inline Session/Model/Settings panels; friendly empty-state + retry when the binary isn't configured. |
| **views/PromptPopout.ts** | Per-instance floating/docked/embedded Obsidian `MarkdownView` used as the rich prompt composer; `[[wikilink]]` → `@path` rewriting, ⌘/Ctrl+Enter submit, duplicate-guard, voice-dictation mic, surface switching. |
| **transport/RpcClient.ts** *(vestigial)* | Subprocess lifecycle, id-correlated command/response, event dispatch, exponential back-off restart. Spawned on every desktop load; its only live command consumer is command autocomplete (`get_commands`). |
| **transport/JsonlCodec.ts** | `attachJsonlReader()` — LF-only split, `StringDecoder` for UTF-8 continuations, strips `\r`, never Node `readline`. `serializeLine()` for writes. |
| **transport/AhpClient.ts** | AHP JSON-RPC 0.3.0 WebSocket client: session catalogue, remote PTY terminals (with snapshot replay), hosted sessions, subagent chat streams, reconnect + `reconnect` resume endpoint. |
| **transport/SubprocessLifecycle.ts** | Shared subprocess state machine (6-value state set, crash-restart backoff, dispose guard, in-flight connect dedup) used by both `RpcClient` and `PtyClient` — extracted in FIX SLICE E to stop the two clients re-declaring drifted copies. |
| **transport/ahpStatus.ts** | Single bitmask decoder/encoder for the AHP session status wire field (previously three divergent copies). |
| **transport/AhpTerminalAdapter.ts** | Adapts an AHP remote terminal stream to the same surface `TerminalView` consumes (APC constants shared via `transport/apc.ts`). |
| **transport/HostAgentClient.ts** | Host-agent relay: registers local instances as external farm sessions (`syncInstances`), relays terminal streams, 15 s heartbeat, desktop opt-in. |
| **transport/swarmDispatch.ts** | Headless `pi -p` task dispatch to farm worker hosts; result shown in `DispatchResultModal`. |
| **transport/attachAhpSession.ts / ahpUri.ts** | Binding AHP sessions to terminal leaves; URI scheme-swap conventions (`ahp-session:/` ↔ `ahp-terminal:/`). |
| **views/FarmView.ts** | `'farm-view'` ItemView: catalogue table of farm sessions — bitmask statuses, filters/search/sort, column visibility, group-by-project, live updates, per-row actions (open/archive/dispatch); pushes Farm View settings (concurrency caps, cost alert, auto-cull) to the server. |
| **views/AhpSessionBrowserModal.ts** | Session catalogue browser (live/archived, search, new session). Helpers for session presentation (name/status badges/`formatAgo`/`formatTokens`) live in `views/AhpSessionPickerModal.ts` alongside `NEW_SESSION_ITEM`/`UnifiedAhpItem` and the live-mirror confirm flow. |
| **transport/AuthBridge.ts** + **bridge/auth-bridge.mjs** | Ref-counted SDK auth bridge subprocess (see below). |
| **views/ProviderPanel.ts / ModelBrowserModal.ts / SettingsBridgeModal.ts / OAuthLoginModal.ts** | Auth & provider surfaces backed by the auth bridge. |
| **transport/JsonRunner.ts** | One-shot `pi --mode json` runner — spawns, parses the event stream to completion, returns accumulated text + messages. Feeds `pi-trigger` frontmatter, ` ```pi ` codeblocks, and the run-prompt modal (`HeadlessResultModal`). |
| **vault/VaultContext.ts** | Wikilink → **absolute vault path** resolution, active note/selection capture, apply output (replace selection / append / new note). Resolving to absolute paths keeps `[[wikilinks]]` valid even when a terminal instance's cwd is outside the vault. |
| **notifications/AgentNotifier.ts** | Dispatches Obsidian Notices and/or native OS notifications for agent lifecycle events (`start`/`end`/`error`/`abort`/`question`/`session_start`), prefixing with the instance name or cwd basename; interactive macOS reply buttons route answers back via the `pi:answer:` APC marker. |
| **menubar/*** | macOS menu-bar tray (`menubarEnabled`, default off): cross-vault leader election over a Unix socket, instance menu grouped by vault, live icon styles/thumbnails; `menubar-registry.js` is loaded via `@electron/remote` and is copied by `release.yml` (audit §5 gap fixed). |
| **utils/stt.ts / stt-stream.ts** | Voice dictation: streaming Whisper sidecar (`stt-stream.ts`) for the prompt composer; the batch `MicRecorder`/`transcribe` path was deleted (dead code). |
| **canvas/** | APC `render-canvas` handling: native Electron capture with SVG fallback (`renderCanvas.ts`, `obsidianCapture.ts`). |
| **WikilinkSuggester.ts / CommandSuggester.ts / suggest/** | Inline `[[ ]]`, `/command`, and `@file` autocomplete in the prompt composer. |
| **views/TextInputModal.ts** | Shared `TextInputModal` + `promptForText` helpers (extracted from the deleted `SessionPanel.ts`). |
| **utils/envTokens.ts** | Env-var overrides for secret settings: `AHP_SERVER_TOKEN` → `ahpServerToken`, `STT_TOKEN` (legacy `WHISPER_STT_TOKEN`) → `sttToken`; overridden tokens are omitted from `data.json` persistence. |
| **utils/normalizeSettings.ts** | Type-guarded settings load: per-field whitelists, per-instance validation, deep-merge of nested groups, unknown-key preservation. |
| **utils/errors.ts** | `errorMessage(err)` — shared thrown-value → string normalization for user-facing notices. |
| **types.ts** | `ObsidianPiSettings` + `DEFAULT_SETTINGS` + `PiInstanceConfig`. |
| **types/rpc.ts** | Typed RPC protocol: `RpcCommand` union (`prompt` + `get_commands` only, post-SLICE G), `RpcResponse`, `RpcEvent` union, `RpcSlashCommand`. |

## Multi-instance terminal model

The terminal layer is per-instance:

- `InstanceManager` owns one `PiInstance` per configured terminal instance.
- Each `PiInstance` bundles exactly one `PtyClient`, one `TerminalView`, one `PromptPopout`, and a
  private `pendingResumeSessionPath`.
- `InstancePaths` provides per-instance cwd, session directory, and prompt-note path resolution.
  The default instance keeps backward-compatible legacy paths.
- `TerminalView` is bound to a single instance id via view state; its toolbar label shows the
  instance name and cwd basename. The same view hosts local PTY terminals and AHP remote terminals.
- `TerminalIcon` registers numbered `squircle-dash` icons (`pi-terminal-1`, `pi-terminal-2`, …)
  so each terminal leaf is visually distinct.
- `InstancePickerModal` fuzzy-searches instances by name and displays each effective cwd.
- `main.ts` registers dynamic commands `Open pi terminal: <name>` for every configured instance.
- `AgentNotifier` receives `instanceId` + `cwd` on every notify event and prefixes in-app/OS
  notifications with the instance name or cwd basename.
- Crash/reconnect state is isolated per instance: `InstanceManager.wireStateNotices()` prefixes
  notices with `pi [name]`, and a failure in one PTY does not affect other instances.
- `VaultContext.replaceWikilinks()` resolves `[[Note]]` to absolute vault paths, so prompts
  composed in a per-instance prompt note still reference vault files correctly when the instance's
  cwd is outside the vault.

## AHP remote sessions & Farm View

- The plugin connects to the AHP broker over WebSocket (`ahpServerUrl`, JSON-RPC protocol
  version 0.3.0). One shared `AhpClient` serves the session catalogue, Farm View, and terminal
  attach flows.
- **Remote terminals**: an AHP session can be opened as an interactive terminal — PTY bytes
  stream over the WebSocket, with snapshot replay on attach, and the same `TerminalView` +
  APC prompt-submit path used for local terminals.
- **Hosted sessions**: `newHostedAhpSession` asks the broker to spawn a pi instance on the
  server host and attaches to it.
- **Subagent mirrors**: read-only live mirrors of subagent sessions, using the URI
  scheme-swap convention in `transport/ahpUri.ts` (`ahp-session:/` ↔ `ahp-terminal:/`).
- **Farm View** (`views/FarmView.ts`): the catalogue table over the broker's session list —
  bitmask status decoding, filters/sort/grouping, live updates, external/local toggles, and
  per-row actions; Farm View settings are pushed to the server (provider concurrency caps,
  cost alert threshold, auto-cull idle minutes).
- **Swarm dispatch** (`transport/swarmDispatch.ts`): dispatch a headless `pi -p` task to a
  worker host; the result is presented in `DispatchResultModal`.

The wire-contract bugs catalogued in `docs/AUDIT-2026-09-01.md` §1.1 (dead
`session/chat*` listeners, discarded reconnect snapshots, terminal subscriptions not
restored on reconnect, shared-client disposal on create failure) have been fixed —
`AhpClient` now applies reconnect snapshots to session-chat subscribers, re-subscribes
tracked terminal channels on reconnect, and the shared client survives failed hosted
session creates.

## SDK auth bridge (shipped)

The auth bridge has **shipped** — it is not a pending phase.

- **Subprocess**: `bridge/auth-bridge.mjs` — a small, separately shipped Node-ESM script
  (deliberately *not* bundled into `main.js`): it imports `AuthStorage`/`ModelRegistry`/
  `SettingsManager` directly from the installed pi package. This avoids esbuild bundling the
  whole SDK dependency graph through its barrel `index.js` export (the package has no subpath
  `exports` and no `sideEffects: false`, so tree-shaking a bundled import isn't reliable).
- **Client**: `src/transport/AuthBridge.ts` resolves the pi SDK entry point from the detected
  pi binary path and JSONL-frames the subprocess. The bridge is **ref-counted**
  (`ensureAuthBridge()`/`releaseAuthBridge()`) so concurrent panel callers share one
  subprocess; lifecycle is defensive (SIGTERM→SIGKILL escalation, cleared timers).
- **Consumers**: `ProviderPanel` (auth status, keys), `OAuthLoginModal` (OAuth login/logout),
  `ModelBrowserModal`, `SettingsBridgeModal` (pi `settings.json`), and the TerminalView inline
  Model/Settings panels.
- **Requirement**: the bridge imports the SDK from the pi installation, so it requires an
  **npm-global, Node-script install of pi** (`.../node_modules/@earendil-works/pi-coding-agent/
  dist/cli.js`). With a compiled/packaged pi binary the bridge cannot resolve the SDK and the
  auth/provider panels degrade accordingly.

## Platform support

`manifest.json` sets `"isDesktopOnly": false` — the plugin loads on mobile, but transports
are gated at runtime (`Platform.isDesktop` guards in `main.ts`):

| Capability | Desktop | Mobile |
|---|---|---|
| Local PTY terminal (`node-pty`), local RPC, JSON one-shot mode, session resume, image paste, canvas render | ✅ | ❌ (guarded by `requireDesktopFor`) |
| Prompt popout composer (floating/docked/embedded) | ✅ | partial (embedded/docked surfaces) |
| AHP remote sessions (catalogue, remote terminals, hosted sessions, mirrors) | ✅ | ✅ |
| Farm View catalogue | ✅ | ✅ |
| Host-agent relay (publish + stream relay) | ✅ opt-in | ❌ |
| Auth bridge (provider/OAuth/model/settings panels) | ✅ | ❌ (subprocess + `@electron/remote` dependency) |
| macOS menubar tray | ✅ (macOS, opt-in, default off) | ❌ |
| STT voice dictation | ✅ | ❌ |

The ribbon icon reflects this: desktop shows the terminal ribbon (with the instance hub),
mobile shows the AHP session opener.

## RPC protocol notes (critical for the vestigial RPC surface)

- **Framing:** split records on `\n` **only**; strip a trailing `\r`. **Do not** use Node
  `readline` — it also splits on `U+2028`/`U+2029`, which are valid inside JSON strings.
- **Correlation:** every command may carry an `id`; the matching `response` echoes it.
  Events have **no** `id` and stream asynchronously.
- **Extension UI:** pi's extension-UI sub-protocol (`extension_ui_request` /
  `extension_ui_response`) is **no longer handled** — the `obsidian-bridge` extension
  resolves dialogs/answers via APC markers in the terminal flows, so the plugin never
  needs the RPC round-trip (FIX SLICE G deleted the handler).
- **Plugin-sent commands:** only `prompt` and `get_commands` remain in `RpcCommand`
  (pi itself still supports the full chat-era set — steer/fork/clone/compact/… — the
  plugin simply never sends them).
- **Key events:** `agent_start/_end`, `turn_start/_end`, `message_start/_update/_end`
  (with `assistantMessageEvent` deltas: `text_delta`, `thinking_delta`, `toolcall_*`),
  `tool_execution_start/_update/_end`, `queue_update`, `compaction_*`, `auto_retry_*`,
  `extension_error`.

## APC protocol (obsidian-bridge tunnel)

APC (Application Program Command) markers are shared between the local `PtyClient` and the
remote `AhpTerminalAdapter` via `src/transport/apc.ts` (constants: `APC_PREFIX = ESC _`,
`APC_TERM = ESC \` ST-terminated, as required by the pi-tui stdin buffer):

- **Prompt submit** (plugin → pi): `ESC _ pi:prompt:<base64(text)> ESC \` — the bridge
  extension parses this out of the TUI stream and submits it to the agent. The alternative
  `promptSubmitMode: 'paste'` pastes text + Enter instead.
- **Answer routing** (plugin → pi): `ESC _ pi:answer:<questionId>:<base64(JSON
  {answer, wasCustom})> ESC \` — resolves an in-flight question panel when the user replies
  from an OS notification.
- **Canvas render** (pi → plugin, plugin → pi): `pi:render-canvas:` request and
  `pi:render-canvas-result:` reply (`{requestId, success, error?, pngB64?}`) — native
  Electron capture with an SVG fallback on the pi side.
- The bridge extension also handles `notify`/`get-text` flows that power the interactive
  macOS notification replies.

The bridge lives in `extensions/obsidian-bridge.ts` and is **shipped as raw TypeScript** on
purpose: pi loads TS extensions via its own TS loader. (A duplicate inlined copy of
`render_canvas` inside the extension is a known drift risk — see `FEATURES.md` §E.)

## Prompt-note plumbing

- Each instance gets a hidden prompt note — `pi prompt — <name>.md` via
  `InstancePaths.promptNoteFilename()` (the legacy default instance uses
  `settings.promptNotePath`); the notes are CSS-hidden from the vault.
- The prompt popout is a real `MarkdownView`, so the full editor works: `[[` wikilink,
  `/command`, and `@file` suggesters (the file suggester optionally shells out to `fd`).
- On submit, `[[wikilinks]]` are rewritten to absolute vault paths (`VaultContext`), and the
  prompt is delivered either via the APC marker or paste, per `promptSubmitMode`.
- Prompt notes rename bi-directionally with their instance name; images are attached by
  writing clipboard contents to a temp file and referencing it as `@path`.

## Setup (dev)

1. `cd <vault>/.obsidian/plugins/obsidian-pi/`
2. `npm install`
3. `npm run dev` (esbuild watch → outputs `main.js` in same directory, touches `.hotreload`)
4. Reload Obsidian (or use a hot-reload community plugin); enable in Community Plugins
5. `pi` auto-detected from npm global install; set explicit path in settings if needed

**Binary detection** (no PATH required — Electron's PATH is stripped):
1. Probe npm global module roots (`/opt/homebrew/lib/node_modules`, `/usr/local/lib/node_modules`, …) for `@earendil-works/pi-coding-agent/dist/cli.js`
2. Find `node` (`/usr/local/bin/node` → `/opt/homebrew/bin/node` → shell `which node`)
3. Spawn `node cli.js --version` to validate

## Auth

Default: delegate to pi's own credential storage (`~/.pi/agent/auth.json`) and env vars —
the subprocess resolves keys itself, so the plugin holds no secrets. Optional advanced
mode: a plugin-managed runtime API key passed to the subprocess environment (held in memory
only, never persisted to disk or the vault). The SDK auth bridge (above) surfaces OAuth
login/logout, provider keys, model browsing, and pi `settings.json` editing through
dedicated panels. AHP broker and STT tokens default to empty and can be supplied via the
`AHP_SERVER_TOKEN` / `STT_TOKEN` (or legacy `WHISPER_STT_TOKEN`) environment variables —
when set, they override the settings value and the token is never written back to
`data.json` (see `src/utils/envTokens.ts`; plaintext persistence flagged in
`AUDIT-2026-09-01.md` §4).

## Testing

- Manual scenarios: `TESTING.md`
- Automated: `vitest` — **29 suites / 425 tests** covering:
  - **Transports**: `JsonlCodec` (framing edge cases: `\r\n`, `U+2028`/`U+2029` inside
    strings, partial-chunk reassembly), `RpcClient` (id-correlation, event dispatch),
    `PtyClient`, `AhpClient`, `AhpTerminalAdapter`, `AhpActionMapper`, `HostAgentClient`,
    `swarmDispatch`, `attachAhpSession`.
  - **Instances**: `InstanceManager`, `InstanceStats`, AHP terminal restore.
  - **Views & UI logic**: `FarmView` (exercised via a hand-rolled `FakeEl` DOM stand-in
    under the node environment — there is **no jsdom**), menubar modules
    (`MenubarIcon`, `MenubarIconArt`, `MenubarMenuBuilder`, `MenubarPopover`,
    `menubarSnapshot`), `AgentNotifier`, canvas modules, fuzzy/file-search utils,
    image attach, `VaultContext`, settings normalization (`normalizeSettings`),
    `main.test.ts`.
- **Known gaps** (no unit tests): `TerminalView` logic, `PromptPopout` (~2.2k lines),
  `SettingsTab`, `MenubarCoordinator`/`MenubarIpc`, `AuthBridge`, `JsonRunner`,
  `binary.ts`, suggesters, `InstancePaths`/`instanceActions`.
  See `docs/AUDIT-2026-09-01.md` §5.
- Run with `npm test` from the plugin directory.

## Deployment / Release

- Version `manifest.json` + `versions.json` together (Obsidian compatibility mapping).
  **The release workflow copies `versions.json` verbatim**, so every release **must** gain a
  `"<version>": "<minAppVersion>"` entry — the 0.4.0 entry was missing at audit time
  (`AUDIT-2026-09-01.md` §5) and has since been added. See `docs/RELEASE_CHECKLIST.md`.
- `menubar-registry.js` is `require()`d at runtime via `@electron/remote.require`
  (`MenubarIcon.ts`); it is copied by `.github/workflows/release.yml` (copy step + release
  asset) as of the audit remediation — previously the tray self-healing broke on
  distributed installs.
- The workflow ships `bridge/auth-bridge.mjs` (required by the auth bridge) and
  `extensions/obsidian-bridge.ts` **as raw TypeScript** — intentional, since pi loads TS
  extensions itself (guarded by a canvas test that exercises it).
- `vendor/node-pty-darwin-arm64` is copied into the distributed tree so a `git clone` of the
  main branch needs no node-pty build (darwin-arm64 only — other platforms must `npm install`).
- Distribute as a BRAT beta first, then submit to the community plugin list.

## Open questions

- ~~Bundle the in-process SDK as a fallback, or stay subprocess-only?~~ → staying subprocess-only
  for the RPC/PTY/JSON transports. The auth bridge is the narrow, shipped exception (see above).
- Sandbox/permission model for `bash`/`edit`/`write` tools operating on the vault.
- ~~Diff-preview before applying agent output to notes~~ → shipped
  (`HeadlessResultModal` editable preview + explicit apply actions).
- ~~Single terminal vs. multi-instance terminal UX~~ → shipped
  (`InstanceManager` + `PiInstance` + per-instance PTY/view/popout/resources).
- ~~Desktop-only vs. mobile~~ → shipped: `isDesktopOnly: false`, with per-transport
  capability gating (see [Platform support](#platform-support)).
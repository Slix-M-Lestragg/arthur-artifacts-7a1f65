# Using a remote pi from Obsidian

This guide shows how to drive a **remote `pi` agent** hosted by `pi-ahp-server` from the
`RnD-obsidian-pi` Obsidian plugin. The server ("agent host") spawns a real `pi --mode rpc`
process per session, scoped to a working directory, and streams live turns over AHP
(Agent Host Protocol, JSON-RPC 2.0, protocol `0.3.0`). The plugin is the frozen compatibility
client — all wire shapes are preserved, so no plugin changes are required to attach to hosted
sessions.

## What you need

- A running `pi-ahp-server` reachable from your machine over WebSocket (default `:4500`).
- The `RnD-obsidian-pi` plugin installed and enabled in Obsidian.
- A hosted pi session, created either with the plugin's **"pi: AHP — new hosted pi
  session"** command or out-of-band (see step 3).

## 1. Make the server reachable

- **Local server:** start it with `docker compose up` (or `node dist/src/index.js`),
  listening on `:4500`. Reach it at `ws://localhost:4500`.
- **Remote server:** open an SSH tunnel and point the plugin at localhost:

  ```bash
  ssh -L 4500:localhost:4500 user@your-host
  ```

  then use `ws://localhost:4500` in the plugin (see `pi-ahp-server/README.md`, "Remote pi
  over SSH"). The server advertises `pi` in `RootState.agents`.

## 2. Configure the plugin

Open Obsidian **Settings → Remote AHP server URL** and set it to your server URL, e.g.
`ws://localhost:4500` (or `ws://<tailnet-host>:4500` for a Tailnet host). This is the only
AHP-specific setting; an empty value falls back to `ws://localhost:4500`.

(Settings key: `ahpServerUrl`, defined in `src/types.ts`, default in `DEFAULT_SETTINGS`,
UI in `src/views/SettingsTab.ts`.)

## 3. Create a hosted pi session

The plugin now has an in-UI command for this. Run **"pi: AHP — new hosted pi
session"** and fill in the two prompts:

- **Session name** (default `pi-<vault-name>` or `pi-<timestamp>`) — becomes `ahp-session:/<name>`.
- **Server-side working directory** — an **absolute path on the agent host**, e.g.
  `/home/ulysse/RnD/AHP`. The plugin converts it to a `file://` URI (so
  `/home/ulysse/RnD/AHP` becomes `file:///home/ulysse/RnD/AHP`) and sends it as
  `workingDirectory`.

The plugin connects to the configured AHP server, calls:

```jsonc
{
  "jsonrpc": "2.0", "id": 1, "method": "createSession",
  "params": {
    "channel": "ahp-session:/<name>",
    "provider": "pi",
    "workingDirectory": "file:///absolute/path/to/project"
  }
}
```

The server spawns a real `pi` scoped to that directory and **auto-creates** the
matching `ahp-chat:/<name>`. The plugin derives the chat URI by swapping the
session scheme (`ahp-session:` → `ahp-chat:`), subscribes to both, registers the
synthetic AHP instance, and opens the **AHP Terminal** view.

If the server rejects the request (e.g. `pi` is not installed server-side), a
Notice shows the JSON-RPC error and the UI is not left hanging.

**Fallback (out-of-band):** If you prefer, you can still create a hosted session
with one of the out-of-band methods:

- `pi-ahp-server/scripts/live-smoke.mjs`, or
- a one-liner WebSocket/JSON-RPC client that calls:

  ```jsonc
  {
    "jsonrpc": "2.0", "id": 1, "method": "createSession",
    "params": {
      "channel": "ahp-session:/pi-myproj",
      "provider": "pi",
      "workingDirectory": "/absolute/path/to/project"
    }
  }
  ```

Omitting `provider` keeps the old relay/echo behavior (used by the **Connect to
remote AHP server** command).

## 4. Open the session picker and attach

Run the command **pi: AHP — open remote session**. The plugin calls `subscribe('ahp-root://')` and
`listSessions({ channel: 'ahp-root://', limit })` (most-recently-modified first), and also
receives live `root/sessionAdded` / `root/sessionSummaryChanged` /
`root/activeSessionsChanged` notifications — so hosted sessions appear in the picker **with
no plugin changes**. (If a server didn't implement `listSessions`, the client falls back to
the root-notification catalogue; the upgraded server implements it, so the `-32601` fallback
is no longer hit.)

Select a hosted session. The plugin calls
`attachSession('ahp-session:/pi-<id>', 'ahp-chat:/pi-<id>')` — it attaches to the existing
chat, it does **not** create a new session — and opens the **AHP Terminal** view.

## 5. Chat with the hosted pi

Type a message and press **Enter**. The plugin sends:

```jsonc
{ "jsonrpc": "2.0", "method": "dispatchAction",
  "params": {
    "channel": "ahp-chat:/pi-<id>",
    "clientSeq": 1,
    "action": { "type": "chat/turnStarted", "turnId": "turn-…",
                "message": { "text": "your message", "origin": { "kind": "user" } } }
  } }
```

The server prompts the hosted `pi` and streams back action envelopes, each carrying a
monotonic `serverSeq`, in this order:

```
chat/turnStarted → chat/delta (×N) → chat/toolCallStart → chat/toolCallComplete
                 → chat/usage → chat/turnComplete
```

`AhpActionMapper` maps these to internal events and the `AhpTerminalAdapter` renders them
live in the AHP terminal view — assistant text as it streams, tool-call start/complete, and a
blank line after the turn ends.

After the turn completes, `chat/usage` (model, input/output tokens, cost) is folded into a
synthetic assistant message and surfaces in the **terminal tab tooltip** (hover the tab icon)
via `InstanceStats`.

---

## Q2 — Session creation gap

**DONE.** `AhpClient.createSession(channel, opts?)` now accepts optional
`provider` and `workingDirectory` fields and forwards them only when present, so
existing no-argument calls stay byte-compatible with the relay/echo path
(`src/transport/AhpClient.ts`). The plugin command **"pi: AHP — new hosted pi
session"** (`src/main.ts`) prompts for a session name and a server-side absolute
working directory, sends `createSession` with `{ channel, provider: 'pi',
workingDirectory }`, derives the auto-created chat URI by scheme-swap, subscribes
to both channels, and opens the AHP terminal view. Hosted sessions can now be
created directly from the Obsidian UI.

The out-of-band `pi-ahp-server/scripts/live-smoke.mjs` / one-liner methods remain
available as a fallback.

## Q3 — Settings / UX caveats

- **DONE — Auto-reconnect with exponential backoff.** `AhpClient` now tracks
  `lastServerSeq` per channel from every incoming action envelope and, when an
  already-connected WebSocket drops unexpectedly, schedules an automatic reconnect
  (`1 s → 30 s` exponential backoff, up to 10 attempts). On reconnect it calls the
  server's `reconnect` endpoint with the smallest observed `lastSeenServerSeq` and
  resumes via either the `{type:"replay", actions}` or `{type:"snapshot", snapshots}`
  response. A replay feeds action envelopes through the same `applyActionEnvelope`
  path used by live traffic, so turn history is preserved without a manual re-run.
  Calling `dispose()` explicitly stops all reconnection attempts; after 10 failed
  attempts the client settles in `disconnected` with an error. The root catalogue is
  re-seeded from snapshots/`listSessions` and root handlers are re-wired once.
- **`chat/usage` surfaces in the terminal tab tooltip** (model / tokens / cost), not an inline
  banner. After a turn, hover the terminal tab icon to see it.
- **DONE — `ahp-terminal:/pi-<id>` interactive PTY terminal.** The plugin now
  has a command **"pi: AHP — open interactive terminal for session"** that
  subscribes to `ahp-terminal:/pi-<id>` and renders a true interactive PTY in
  the AHP Terminal view. Server output arrives via `terminal/data` and is written
  directly to xterm; every keystroke is forwarded raw via `terminal/input` with
  no local line buffering or optimistic echo (output is server-authoritative).
  Resize is best-effort via a `terminal/resize` action (name to confirm with the
  server team). The server gracefully degrades with a `-32000` JSON-RPC error
  when node-pty is not installed server-side, surfaced as a Notice.
- The server's new `resourceRead` / `resourceList` / `resourceResolve` (root channel, scoped
  to session working directories) are also not surfaced by the plugin yet.

---

## Validating the end-to-end (TESTING.md T15)

Mirror `pi-ahp-server/scripts/live-smoke.mjs` against a running server, then confirm in
Obsidian:

1. Server up (`docker compose up` or `node dist/src/index.js`) on `:4500`; tunnel if remote.
2. Create a hosted session:
   - **UI:** run **pi: AHP — new hosted pi session**, name it `pi-t15`, and enter the
     server-side working directory.
   - **Out-of-band:** `createSession({ channel:'ahp-session:/pi-t15', provider:'pi', workingDirectory:'/path' })`.
3. In Obsidian: set the server URL, run **pi: AHP — open remote session**, confirm `pi-t15` appears in the
   picker.
4. Attach, type "hello", press Enter, confirm live `chat/delta` + `chat/toolCall*` +
   `chat/usage` + `chat/turnComplete` render in the AHP terminal, and the tab tooltip shows
   usage after the turn.
5. If all pass, check off **T15** in `~/RnD/AHP/TESTING.md` (server-side scenario).

> Note: the `pi-ahp-server` repo and its `TESTING.md` (where T15 lives) are maintained on the
> server side; the plugin vault cannot check them off. Run the steps above against a live
> server and record the result there.

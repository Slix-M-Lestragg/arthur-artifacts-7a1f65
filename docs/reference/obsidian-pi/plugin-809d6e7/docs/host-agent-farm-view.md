# Host-agent relay — all-devices Farm View

The **Farm View** (`pi: Open Farm view`) shows every pi session on your AHP server in one
table. The **host-agent relay** turns any desktop vault into a *host*: it registers the
vault's local stdio pi instances with the central `pi-ahp-server`, and every other device
connected to that server sees them in its own Farm View as **external sessions**, tagged
with your device name. Opening one attaches to a **relayed terminal** — keystrokes go over
WebSocket to the server, which forwards them to the real local `pi` process on your machine
and streams the output back. No SSH, no port forwarding, no shared configuration.

- **Plugin side (this repo):** `HostAgentClient` (`src/transport/HostAgentClient.ts`) + the
  Farm View consumer (`src/views/FarmView.ts`, `src/main.ts` `openAhpTerminalForSession`).
- **Server side:** `pi-ahp-server` (host-agent wire contract — `hostAgent.register`,
  `syncInstances`, `terminalData`/`terminalInput`, heartbeat).

## 1. How it works

The host agent is a desktop-only, opt-in relay:

1. **Register** — on enable, the plugin connects to the configured AHP server and calls
   `hostAgent.register { deviceName, token? }`, receiving a server-assigned `hostAgentId`.
2. **Sync** — it watches the vault's `InstanceManager` and announces each local pi instance
   (`hostAgent.syncInstances`) with **stable instance ids**, so reconnects don't create
   duplicate rows. Status/model/usage rollups are forwarded from the running instances.
3. **Tee, not spawn** — the relay spawns nothing. It forwards each local instance's existing
   PTY data stream to the server (`terminalData`) and writes incoming `terminalInput` into
   the real PTY, so a remote opener controls the exact process already running on the host.
4. **Keep-alive** — a 15 s heartbeat keeps the row `hostOnline: true`; on disconnect the
   agent unregisters gracefully (and re-registers + re-syncs on reconnect).

The server advertises these instances in the root catalogue as sessions with
`kind: 'external'`, `hostAgentName: <deviceName>`, `hostOnline`, and `terminalMode: 'external'` —
exactly like hosted sessions, but owned by the device that announced them.

## 2. Enabling the host agent (desktop)

Open **Settings → Host agent**:

| Setting | What it does |
|---|---|
| **Enable host agent** | Registers this Mac's local pi instances with the Farm View server. Desktop only. |
| **Device name** | How this device appears in the Farm catalogue (`hostAgent.register` `deviceName`). Default `Voyager`. |
| **Server token** *(optional)* | Shared farm token. If the server runs with `AHP_SERVER_TOKEN` set, enter the same token here — it is sent with `initialize` and `register` (one trust domain for clients and host agents). Leave empty when the server has no token. |

After enabling, the **Status** line shows `Connected · hostAgentId … · N instance(s)
announced`. Open the Farm View (`pi: Open Farm view`) and confirm your pi instances appear
as external rows on every device connected to the same server.

(Settings keys: `hostAgentEnabled`, `hostAgentDeviceName`, `ahpServerToken` — `src/types.ts`,
UI in `src/views/SettingsTab.ts`.)

## 3. What the Farm View shows

- **External rows** carry a **laptop badge + device name** (e.g. `Voyager`) next to the
  session name, so server-hosted sessions, relayed device sessions, and local instances stay
  visually distinct (hosted rows get no badge; local rows get the monitor badge).
- **Offline hosts** — when a host agent disconnects (laptop asleep, Obsidian closed, network
  down) the server keeps the session listed but marks the host offline: the row is **greyed
  out with a `host offline` badge**, and opening it is blocked with a
  `Host offline — <device> not connected` notice (the server would skip streaming to a dead
  host, so the view never opens with stale scrollback).
- **Opening a relayed terminal** — clicking **Open** on an online external row subscribes to
  the relayed `ahp-terminal:` channel. The subscribe snapshot replays the **accumulated
  scrollback and the real PTY size** into the terminal before live data streams, so a late
  opener sees the terminal exactly as it already is — no blank screen + redraw races. Typing
  is forwarded raw to the real local `pi`. If the owning host's local PTY is no longer
  running, the server answers with a `-32000` error and the plugin shows
  `Host terminal not running on <device>` (the session row stays listed).
- **Local rows as fallback** — when the host agent is on and announces an instance, the
  matching client-side local row is **suppressed** so each pi appears exactly once (as the
  relayed external row). When the host agent is off (or absent), the vault's own instances
  reappear as **local rows** (monitor badge) — the offline fallback that keeps your machines
  usable even when the relay is down.

## 4. Mobile and other consumer devices

Mobile is a **pure consumer**: the host agent is only ever constructed on desktop
(`Platform.isDesktop`), so a mobile vault can never host its own instances. It still sees
the **full external catalogue** — including sessions relayed by your desktop vaults — and can
open relayed terminals; it just can't announce instances back to the server.

---

See also: [`remote-pi-from-obsidian.md`](./remote-pi-from-obsidian.md) (hosted pi sessions on
the AHP server) · [`technical.md`](./technical.md) (plugin architecture).

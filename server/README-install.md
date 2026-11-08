`arthur-agent` — server install (one page)

`server/` holds the pieces that run on the arthur home server (the machine
hosting ComfyUI + ai-toolkit), not the Obsidian plugin itself. The agent is
at **v0.8.2** (GPU-aware spawning + pi session aggregation + the pi device
registry / SSH dir listing / session spawn endpoints + unmanaged-instance
visibility + pi-ahp-tty AHP terminal launch):

```json
{"known": {"comfyui": {"0": null, "2": [1], "3": [0, 1]}}}
```

A runtime drop-in `/run/systemd/system/comfy@<i>.service.d/override.conf`
containing `Environment=ARTHUR_GPUS="<list>"` pins each explicit set (the
agent writes it + `systemctl daemon-reload` around every start/restart/spawn
of a pinned index, and removes it on stop / forget / stop-all-forget, again
with a daemon-reload). The template unit honors `ARTHUR_GPUS` when set and
falls back to the modulo default otherwise.

| file                  | deploy target                          | purpose |
|-----------------------|----------------------------------------|---------|
| `arthur-agent.py`     | `/opt/arthur-agent/arthur-agent.py`    | companion agent: service registry, dynamic instances, lifecycle control, audit log |
| `config.json`         | `/etc/arthur-agent/config.json`        | the service registry (schema v2, below) |
| `comfy@.service`      | `/etc/systemd/system/comfy@.service`   | multi-instance ComfyUI template unit: port = `8188+i`; GPU set = `i % NUM_GPUS` modulo default, or an explicit set pinned by an `ARTHUR_GPUS` runtime drop-in (v0.6.0) |
| `comfy-dual.service`  | `/etc/systemd/system/comfy-dual.service` | dual-GPU ComfyUI unit (v0.5.2): one process on **both** GPUs (`CUDA_VISIBLE_DEVICES=0,1` + `--cuda-device 0,1`), port `8190`; installed **enabled but stopped** |
| `arthur-agent.service`| `/etc/systemd/system/arthur-agent.service` | agent unit, listens on `0.0.0.0:8766` |

The agent is a **single-file Python 3 stdlib server** (no pip deps, v0.7.0).
It exposes a *service registry* — services are defined once in config.json and
instances are **computed**, never stored from requests. Request data is never
interpolated into shell commands; the agent only ever runs `systemctl
start/stop/is-active|show <unit-from-config>`, `systemctl daemon-reload`,
`nvidia-smi -L` (GPU count) and the read-only `nvidia-smi --query-gpu=...`
stats query, all with subprocess timeouts. The only other writes besides the
state/audit files are the per-index runtime drop-ins under
`/run/systemd/system/comfy@<i>.service.d/` (v0.6.0, GPU-aware spawning).
Every mutation appends one JSON line to the audit log.

The v0.7.0 `/api/pi/status + tail` endpoints are **read-only views** over the
local *pi-sync mirror repo* — see "pi session aggregation (v0.7.0)" below.
They are NOT a systemd-backed service (pi sessions aren't lifecycle-managed)
and stay out of the services registry; they are never audited (audit =
mutations only). The v0.8.0 additions (`/api/pi/devices`,`/api/pi/devices/`
`{dev}/dirs`, `POST /api/pi/sessions`) build on the same pi-sync feed for
*live freshness* but add a config-declared device registry — and the session
spawn **is** a mutation, so it is audited (see the v0.8.0 section below).

## GPU-aware spawning (v0.6.0): spawn-state + runtime drop-ins

The spawned-instance state file (`/var/lib/arthur-agent/instances.json`) is,
per service, a map of spawned instance index → GPU set: an explicit
`number[]` for spawns pinned with a `gpus` body, or `null` for the template
modulo default (`gpus = [i % NUM_GPUS]`). The legacy v0.5.x array shape
(`{"known": {"comfyui": [0, 1]}}`) is migrated on read.

```json
{"known": {"comfyui": {"0": null, "2": [1], "3": [0, 1]}}}
```

A runtime drop-in `/run/systemd/system/comfy@<i>.service.d/override.conf`
containing `Environment=ARTHUR_GPUS="<list>"` pins each explicit set:

```ini
# /run/systemd/system/comfy@2.service.d/override.conf — managed by arthur-agent
[Service]
Environment=ARTHUR_GPUS="0,1"
```

Lifecycle of the drop-in:

- **spawn (explicit gpus body)** → written (atomic tmp+rename) +
  `systemctl daemon-reload` **before** `systemctl start`.
- **start / restart** of a spawned index → re-synced from spawn-state (so a
  pinned instance keeps its GPUs across stop/start and after a reboot, which
  wipes `/run`); no-body starts remove any stale pin.
- **stop / forget / stop-all-forget** → removed (+ daemon-reload) so freed
  indexes don't inherit stale GPU assignments.

The template unit (`comfy@.service`) computes
`GPUS="${ARTHUR_GPUS:-$(( i % NGPU ))}"`, exports `CUDA_VISIBLE_DEVICES=$GPUS`,
and adds `--cuda-device 0,1` only when `$GPUS` contains a comma (multi-GPU
instance; indexes are relative to the visible devices). A single pinned GPU
runs as the only visible device (`cuda:0`) with no `--cuda-device`.

## Semantics (v0.5.0 model, extended in v0.5.2)

- **Service** = a systemd-managed app from the registry. Two kinds:
  - `multi_instance: true` (comfyui): runs a **template unit** `comfy@{i}`.
    Instance *i* listens on `default_port + i`, and its GPU list is
    `[i % NUM_GPUS]` (NUM_GPUS detected live via `nvidia-smi -L` at each
    status/spawn). Instance ids are `<instance_prefix>-<i>`, e.g. `comfy-0`,
    `comfy-2`.
  - `multi_instance: false` (aitoolkit): exactly one instance, id = service id
    (`aitoolkit`), fixed unit `ai-toolkit.service`. **Spawning returns 409** —
    ai-toolkit has shared SQLite state and must never be duplicated.
- **Default instance** = index 0 (`comfy-0` / `aitoolkit`). Service
  start/stop operate on it (start) or all instances (stop).
- **Spawn** picks the lowest index in `0..max_instances-1` whose unit is not
  currently active. A stopped spawned instance's port/id may be reused by the
  next spawn. Instance indexes remembered as *spawned* persist (state file)
  so the instance stays listed while stopped. **Extra instances do NOT
  consume spawn indexes** — spawn allocation only ever walks the template
  index range.
- **GPU-aware spawning (v0.6.0)**: the spawn endpoint accepts an optional
  JSON body `{"gpus": [1]}` or `{"gpus": [0, 1]}` pinning the instance's
  `CUDA_VISIBLE_DEVICES`. The set must be non-empty, unique and every index
  must exist on the host (`nvidia-smi -L`); otherwise **400**. A pinned set
  is written as a runtime systemd drop-in
  (`/run/systemd/system/comfy@<i>.service.d/override.conf` setting
  `ARTHUR_GPUS="<list>"`) + `systemctl daemon-reload` before start, recorded
  in spawn-state (so stop→start keeps it; a reboot wipes the drop-in and the
  start path re-creates it from spawn-state), and removed on
  stop/forget/stop-all. A spawn **without a body** keeps the v0.5.x
  behavior: `gpus = [i % NUM_GPUS]`, no drop-in (stale pins get cleared).
  Port allocation is unchanged: `default_port + i`. The spawn response is
  the usual `201 {"action": "spawn", "result": "spawned", "instance": {…}}`
  with `gpus` (the pinned set) and `gpu` (`gpus[0]` iff exactly one GPU,
  else `null`). Multi-GPU instances additionally launch ComfyUI with
  `--cuda-device 0,1` (indexes relative to the visible devices, handled
  inside `comfy@.service`).
- **Extra instances (v0.5.2)**: config-declared named instances on units
  outside the template (`extra_instances`, e.g. `comfy-dual` on
  `comfy-dual.service`). They appear in status/instance lists exactly like
  spawned ones, and start/stop/restart work via their unit — but they are
  never part of spawn allocation and are not remembered in the state file
  (they come from config, so they always stay listed).
- **`gpus` vs `gpu`**: every instance carries `"gpus": number[]` — the list of
  GPUs it uses. For template-spawned instances this is the single-element
  array `[i % NUM_GPUS]`; for multi-GPU extras (comfy-dual) it is the full
  list, e.g. `[0, 1]`. The legacy `gpu` field is kept for backward
  compatibility: it equals `gpus[0]` when the array has exactly one element
  and `"gpu": null` otherwise (multi-GPU instance). The plugin should read
  `gpus` going forward; `gpu` remains a convenience singular.
- **`up`** = systemd unit active **and** the instance answers HTTP 200 on its
  `probe_path` (`/system_stats` for ComfyUI, `/` for ai-toolkit).
- **`active`** (service level) = any instance up.

## Deploy (v0.6.0)

```sh
sudo install -m 755 arthur-agent.py /opt/arthur-agent/arthur-agent.py
sudo install -m 644 config.json /etc/arthur-agent/config.json
sudo install -d -m 755 /var/lib/arthur-agent          # spawn-state file
sudo install -m 644 comfy@.service comfy-dual.service arthur-agent.service \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable comfy-dual.service   # enabled but NOT started
sudo systemctl restart arthur-agent
curl -s http://127.0.0.1:8766/health   # → {"ok": true, "version": "0.8.2"}
```

Token lives in `/etc/arthur-agent/token` (root 0600) and `/etc/arthur-agent/env`
(`ARTHUR_AGENT_TOKEN=…`, `ARTHUR_AGENT_BIND=0.0.0.0`, `ARTHUR_AGENT_PORT=8766`).
Migrating from v0.4 config keeps the token unchanged; the plugin uses the same
token.

## config.json — schema v2.1 (/etc/arthur-agent/config.json)

Same as schema v2 plus the optional per-service `extra_instances` array
(v0.5.2). The optional top-level `pi_devices` object (v0.8.0 — the pi device
registry) is documented in its own section above; it is additive and validated
with fatal-config-error strictness like the services registry.

```json
{
  "services": {
    "comfyui": {
      "name": "ComfyUI",
      "default_port": 8188,
      "unit_template": "comfy@{i}",
      "instance_prefix": "comfy",
      "max_instances": 4,
      "multi_instance": true,
      "probe_path": "/system_stats",
      "install_dir": "/mnt/work/00-TOOLS/comfyui",
      "extra_instances": [
        {"id": "comfy-dual", "port": 8190, "gpus": [0, 1],
         "unit": "comfy-dual.service"}
      ]
    },
    "aitoolkit": {
      "name": "AI Toolkit",
      "default_port": 8675,
      "unit": "ai-toolkit.service",
      "max_instances": 1,
      "multi_instance": false,
      "probe_path": "/"
    }
  },
  "num_gpus": 2
}
```

| field | meaning |
|---|---|
| `name` | display name |
| `default_port` | instance *i* listens on `default_port + i` |
| `multi_instance` | template-unit spawning allowed? |
| `max_instances` | hard cap on instance index (spawning 409s past it) |
| `unit_template` | multi only — systemd template unit, `{i}` = instance index |
| `unit` | single only — fixed unit name |
| `instance_prefix` | multi only — instance ids are `<prefix>-<i>` |
| `extra_instances[]` | multi only, **optional (v2.1)** — named instances on units outside the template, listed + controllable like spawned ones but never part of spawn allocation. Each entry: `id` (`[a-z0-9-]+`, unique), `port`, `gpus` (non-empty `number[]`), `unit`, optional `name` |
| `probe_path` | HTTP path used for the liveness probe (default `/`) |
| `num_gpus` | fallback GPU count if `nvidia-smi -L` fails |
| `bind` / `port` | optional; `ARTHUR_AGENT_BIND` / `ARTHUR_AGENT_PORT` env win |

---

## pi AHP terminal spawn (v0.8.2)

Launches `pi-ahp-tty` — the AHP terminal-registering pi supervisor (from the
`pi-ahp-client` extension at `~/.pi/agent/extensions/pi-ahp-client`) —
detached on a target device so the Obsidian plugin can offer
"New pi session → live terminal". The supervisor connects to the AHP
server, creates a session, registers an externally-fed terminal channel,
and mirrors a local node-pty `pi` PTY to it. The agent only launches the
supervisor; **the supervisor itself** sets `AHP_LIVE_MODE=true` and
`AHP_SESSION_ID_OVERRIDE=<id>` on the child `pi` PTY (the launcher does
not). The AHP server URL defaults to `ws://100.75.249.5:4500` (or the
supervisor's `AHP_SERVER_URL` env if set) — the agent does not pass it.

**Per-device prerequisite:** the built CLI must exist at
`$HOME/.pi/agent/extensions/pi-ahp-client/dist/bin/pi-ahp-tty.js` on the
target device AND `node` must resolve on the non-interactive PATH there
(`self`: `~/.local/bin/node` is on the spawn PATH; remote: the ssh login
shell's PATH). On `self` the spawn drops to the config-declared `user`;
on remote devices the launch goes over the same BatchMode ssh mapping used
by `POST /api/pi/sessions`. If the tool is missing on a device the endpoint
responds **422** and spawns nothing.

### POST /api/pi/terminal-sessions — `{device: string, cwd: string}`
Launch `pi-ahp-tty` with `--working-dir <cwd>` (default **resume** semantics
— the most recent pi session in `cwd` — NOT `--fresh`) detached (nohup +
background; survives the HTTP call and agent restarts via `KillMode=process`)
with stdout/stderr redirected to a per-launch log file under the
device/user's `~/.pi/agent/extensions/pi-ahp-client/logs/pi-ahp-tty-<UTC>.log`.
`cwd` is validated exactly like the v0.8.0 session spawn (absolute,
allowlist-prefixed, no `..`) and its existence is checked on the target
first. Every launch — and every refusal — lands in the audit log
(`service: "pi"`, action `terminal-spawn`).

`201` on success:

```json
{"device": "Arthur", "cwd": "/tmp",
 "spawned": "pi-ahp-tty",
 "detail": {"log": "/home/slix/.pi/agent/extensions/pi-ahp-client/logs/pi-ahp-tty-20261108T201500Z.log",
             "pid": 123456}}
```

(`detail.log` is the absolute log path on `self` devices, `~/...`-relative on
remote; `detail.pid` is the supervisor's PID when captured, else `null`.)

Failures use the existing error shapes:
- **400** `unknown device 'x'` (device not in `pi_devices`) / bad `cwd`
  (not absolute / outside the allowlist / `..` segments) / `cwd` does not
  exist on the device.
- **401** unauthorized (missing/invalid bearer token).
- **422** `{"error": "pi-ahp-tty not available on <device>"}` — the tool
  is missing on the device; **nothing is spawned**.
- **502** launch failed (ssh/launcher error preview).
- **503** `device offline` (neither feed-fresh, `self`, nor ssh-reachable).

### GET /api/pi/terminal-sessions — SKIPPED
A listing endpoint was considered (recent launches from the audit log) but
**skipped** — filtering the audit log for `terminal-spawn` entries with
stable response shaping is not trivial, and the live AHP terminal channels
are already observable through the `pi-ahp-client` tooling / broker. The
plugin should drive lifecycle from the AHP side, not by polling this agent.

---

## Unmanaged-instance visibility (v0.8.1)

Instance summaries (`/api/status`, `/api/services*`, `/api/services/{svc}/
instances*` — everywhere instances appear) report THREE orthogonal booleans
next to the classic `up`:

- `managed` — the systemd unit is active (even when the port is dead).
- `live` — the instance's `probe_path` answers HTTP 200 on its port AND, when
  the service config declares `install_dir`, the process listening on the
  port provably runs from that tree (checked via `/system_stats` argv, then
  `ss -ltnp` PID → `/proc/<pid>/cwd`|`exe`|absolute cmdline, verdicts cached
  ~10 s per port). An externally started OWN install (manual systemd start,
  launch script) is **live but unmanaged** — exactly the case the plugin must
  still show.
- `foreign_occupied` — the port ANSWERS but the listener is a DIFFERENT
  install (cwd differs). `live` stays `false`; the plugin renders the down row
  with a 'port held by another process' warning chip.
- `up` — backward-compat lifecycle truth, unchanged math: `managed AND live`.

The top-level service `active` := any instance `managed` OR `live`, so a
service whose instances are all externally started stays green/active.
The instance roster additionally lists template indexes whose port is
OCCUPIED though never spawned (external starts and foreign squatters surface
instead of rendering the service invisibly down).

**Lifecycle safety:** start/stop/restart still target the systemd UNIT ONLY.
Stop on an unmanaged-live instance is a no-op (unit already inactive — the
external process keeps serving); restart ends with a bounded 502 'port still
in use'. The agent NEVER kills a foreign or manual process. `foreign_occupied`
rows cannot be forgotten either (the forget endpoint 409s while the port
answers).

## API surface (v0.8.1; plugin code targets exactly this)

`GET /health` is unauthenticated. **Everything under `/api/` requires
`Authorization: Bearer <token>`.** All responses are JSON; errors are always
`{"error": "message"}` with a fitting HTTP code.

### GET /health (no auth)
`{"ok": true, "version": "0.7.0"}`

### GET /api/pi/status  (v0.7.0)
Aggregated pi session status across all devices publishing into the local
*pi-sync mirror repo*. Read-only; never audited; **not** a service-registry
entry (pi sessions are not systemd-lifecycle-managed).

Producer: the **pi-arthur** extension writes per-device status via **pi-sync
0.2.0**'s status pipe, deployed independently on each pi host — the agent must
tolerate its absence.

Contract files under the pi-sync repo (`~/.pi/agent/pi-sync/repo` by default;
`ARTHUR_PI_REPO` env override, e.g. for tests):

- `status/<Device>.sessions.json` —
  `{device, hostname, updatedAt, sessions: [{id, path, cwd, name, model,
  provider, startedAt, lastActivity, active}], subagents: [{runId, batchId,
  agent, taskPreview, state, parentSessionId, startedAt, finishedAt}]}`
- `devices/<Device>.json` — `{deviceId, hostname, updatedAt, daemon, …}`
  (device info; its `hostname` is the authority and overrides the status
  file's own `hostname` field when both exist)

Each `*.sessions.json` becomes one device entry (file stem = device id);
`stale` is `true` when `updatedAt` parses to more than **5 minutes** ago
(or is missing/unparseable):

```json
{
  "devices": [
    {
      "device": "Arthur", "hostname": "Arthur",
      "repoUpdatedAt": "2026-11-06T21:40:12.000Z",
      "sessionsCount": 3, "activeSessions": 1, "subagentsRunning": 2,
      "sessions": [ {contract sessions entry, verbatim}, … ],
      "subagents": [ {contract subagents entry, verbatim}, … ],
      "stale": false
    }, …
  ],
  "generatedAt": "2026-11-06T21:41:00Z"
}
```

Degradable, not fatal: when the pi-sync repo or its `status/` directory
doesn't exist (producer not deployed yet / repo moved), the answer is still
**HTTP 200** with `{"devices": [], "warning": "pi-sync status unavailable",
"generatedAt": …}`. An unreadable single status file yields a `stale: true`
entry carrying `"error": "unreadable status file"` instead of failing the
whole response.

### GET /api/pi/sessions/{device}/{sessionId}/tail?lines=N  (v0.7.0)
Read-tail of one session's JSONL, for the plugin's session peek. The JSONL
path is resolved from the device's `status/<Device>.sessions.json` entry (`id`
match) — never from the request.

- `lines` is clamped to `1..50` (default 20); non-integer → **400**.
- **Sandbox:** the recorded path is matched against its `realpath()` and only
  accepted when it lies directly under `/home/*/.pi/agent/sessions/` — a
  tampered status file cannot point the tail at arbitrary files → **403**
  otherwise.
- Unknown device / session id / vanished file → **404**.

Response: `{"device", "sessionId", "count", "lines": [...]}` where each line
is a compacted entry — message entries `{type: "message", role,
preview (first ~120 chars of text content, whitespace-collapsed; toolResult
entries prefixed with their `toolName`), timestamp}`, everything else
(e.g. `session`, `model_change`) `{type, timestamp}`. Chronological order,
newest last.
## pi device registry, SSH dir listing, session spawn (v0.8.0)

The config gains a top-level **`pi_devices`** object (optional; the agent
still runs fine without it): the agent device ids the plugin talks about ↔
how to reach their filesystems + where their pi-sync feed lives. Live
freshness/session counts are merged in from the same pi-sync feed the v0.7.0
views use — the registry is *config* for identity, the *feed* for liveness.

```json
"pi_devices": {
  "Arthur":   {"self": true, "user": "slix", "feed": "Arthur",
               "allow": ["/home/slix", "/mnt/work", "/mnt/vault"]},
  "mac.home": {"ssh": "benjaminmatthys@100.93.241.75",
               "feed": "Voyager.local",
               "allow": ["/Users/benjaminmatthys"]},
  "ulysse":   {"ssh": "ulysse@100.75.249.5", "feed": "ulysse",
               "allow": ["/home", "/mnt", "/opt"]}
}
```

| field | meaning |
|---|---|
| `self` | `true` for the agent's own host (local fs listing; the spawn drops into the `user` account to exec the user's own `pi`/`tmux`) |
| `ssh` | remote devices: the BatchMode ssh target `user@host` (required unless `self`) — the agent holds its own key for each target (`/root/.ssh/id_ed25519`, authorized in each target's `authorized_keys`) |
| `user` | local spawn only: the unix account the spawned pi runs as (login env: HOME, PATH incl. `~/.local/bin`) |
| `feed` | the pi-sync device name this machine's sessions/status are read from (defaults to the config key — useful e.g. when the Mac publishes as `Voyager.local`) |
| `allow` | path-prefix allowlist: both the dirs listing and a spawn `cwd` must be absolute, free of `..` segments, and start with exactly one of these prefixes |

### GET /api/pi/devices
The registry merged with live pi-sync-feed freshness (`sessionsActive` /
`sessionsTotal` from the feed's session data; `online` = feed `updatedAt` ≤
5 min old **or** (`self` **and** the feed file exists — the agent's own host
stays online even with a stale-but-present feed)); `reachable` (v0.8.1) adds
the ssh-liveness verdict: feed-fresh **or** `self` **or** a quick BatchMode
ssh probe (`ssh -o BatchMode=yes -o ConnectTimeout=4 user@host true`, cached
per device for 60 s) succeeded.

```json
{"devices": [
   {"id": "Arthur", "hostname": "Arthur", "online": true, "reachable": true,
    "self": true, "ssh": null, "sessionsActive": 1, "sessionsTotal": 3},
   {"id": "mac.home", "hostname": "voyager.local", "online": false,
    "reachable": true, "self": false, "ssh": "benjaminmatthys@100.93.241.75",
    "sessionsActive": 1, "sessionsTotal": 2},
   {"id": "ulysse", "hostname": "ulysse", "online": false, "reachable": false,
    "self": false, "ssh": "ulysse@100.75.249.5", "sessionsActive": 0,
    "sessionsTotal": 0}
 ], "generatedAt": "…"}
```

Devices without any feed entry (never synced — e.g. `ulysse` above) still
list, as offline/idle (0 sessions); their `hostname` comes from the
devices/<Device>.json info file when one exists. `online` stays the
*feed-freshness* signal (the plugin's informational offline row state);
`reachable` is what **`dirs`/`spawn` gate on**.

### GET /api/pi/devices/{device}/dirs?path=<abs>
Subdirectory names for the plugin's directory browser: **sub**-dirs only,
sorted, hidden dirs excluded, `parent` = the browsable parent directory when
it is inside the allowlist (`null` otherwise — e.g. at the allowlist root).
Response: `{"device", "path", "dirs": ["name", …], "parent": "<abs\|null>"}`.

- `self` → local fs listing as the agent (root).
- remote → `ssh -o BatchMode=yes -o ConnectTimeout=6 -o
  StrictHostKeyChecking=accept-new user@host 'cd <path> && ls -p \| grep /'`
  (POSIX/BSD-safe — no GNU-only find/ls flags; BatchMode means it never
  prompts).
- **Path safety**: request paths are absolute-only, `..` segments rejected,
  and must start with one of the device's config-declared prefixes →
  otherwise **400**. Unknown device → **404**; a device that is neither
  feed-fresh nor ssh-reachable (v0.8.1: `reachable == false` — a stale feed
  alone no longer refuses; the cached ssh probe rescues a live, ssh-open
  device) → **503** `{"error": "device offline"}`. A failed remote listing
  → **502** with the stderr preview.

### POST /api/pi/sessions  — `{"device": "…", "cwd": "<abs>"}`
START a pi session in `cwd` on that device. `cwd` is validated exactly like
the dirs paths (absolute, allowlist-prefixed, → **400** otherwise) and its
existence is checked on the target first (`self`: `isdir`; remote: ssh
`test -d` → **400** when missing). Neither feed-fresh nor ssh-reachable
(v0.8.1 `reachable`) → **503**.

Spawn semantics, per target environment:

- **tmux available** (local: the `user`'s `command -v tmux`; remote: ssh
  `command -v tmux`) → `tmux new-session -d -s pi-arthur-<UTC-compact>
  'cd <cwd> && pi'` — the TUI lives in a detached tmux session (under the
  real user/tmux socket in `/tmp/tmux-<uid>/`) that the future obsidian-pi
  plugin can attach to; the session is named `pi-arthur-<UTC-compact>` (e.g.
  `pi-arthur-20261107T074135Z`).
- **Fallback** → `nohup sh -c "tail -f /dev/null \| pi --mode rpc"
  >/dev/null 2>&1 &` — a long-lived pi RPC process with stdin held open.

`201` on success:

```json
{"device": "Arthur", "cwd": "/home/slix", "spawned": "tmux",
 "window": "pi-arthur-20261107T074135Z",
 "hint": "attach with tmux attach -t pi-arthur-20261107T074135Z"}
```

(`window` is the tmux session name or `null` for the rpc-pipe fallback; the
rpc `hint` points at the long-lived process.) Every spawn — and every
refusal — lands in the audit log (`service: "pi"`, action
`session-spawn`). Spawn failure → **502** with an stderr preview.

The pi user's session lands in their own `~/.pi/agent/sessions/--<cwd>--/`
and the pi-sync feed picks it up within seconds — it shows under
`sessionsTotal`/`sessionsActive` on `GET /api/pi/devices` like any other
session.

### POST /api/pi/terminal-sessions  — `{"device": "…", "cwd": "<abs>"}`  (v0.8.2)
Launch `pi-ahp-tty` (the AHP terminal-registering pi supervisor) detached
on the target device with `--working-dir <cwd>` (default **resume**
semantics, NOT `--fresh`). Reuses the v0.8.0 device registry / ssh mapping,
`cwd` allowlist + existence check (→ **400** / **503** exactly like
`POST /api/pi/sessions`). Adds a **pi-ahp-tty availability probe** on the
target (`self`: the built CLI file exists at
`~/.pi/agent/extensions/pi-ahp-client/dist/bin/pi-ahp-tty.js`; remote: ssh
`test -f "$HOME/.../pi-ahp-tty.js" && command -v node`) → **422**
`{"error": "pi-ahp-tty not available on <device>"}` when the tool is
missing, and **nothing is spawned**. The supervisor is launched with
`nohup node <cli> --working-dir <cwd> > <logs>/pi-ahp-tty-<UTC>.log 2>&1 &`
(detached — survives the HTTP call and agent restarts via `KillMode=process`);
the supervisor itself sets `AHP_LIVE_MODE`/`AHP_SESSION_ID_OVERRIDE` on the
child `pi` PTY. Every launch/refusal is audited (`service: "pi"`, action
`terminal-spawn`).

`201` on success:

```json
{"device": "Arthur", "cwd": "/tmp",
 "spawned": "pi-ahp-tty",
 "detail": {"log": "/home/slix/.pi/agent/extensions/pi-ahp-client/logs/pi-ahp-tty-20261108T201500Z.log",
             "pid": 123456}}
```

Failures: **400** unknown device / bad or missing `cwd`; **422** tool
missing on device; **502** launch failed (error preview); **503** device
offline. A `GET /api/pi/terminal-sessions` listing was **skipped** (not
trivial — see the v0.8.2 section above).

Live GPU stats straight from `nvidia-smi --query-gpu=...` (5 s subprocess
timeout):

```json
{"gpus": [{"index": 0, "name": "NVIDIA GeForce RTX 3060",
           "mem_total_mb": 12288, "mem_used_mb": 1878,
           "util_percent": 12, "temp_c": 36}, …], "count": 2}
```

Degradable, not fatal: if nvidia-smi fails/returns nothing the answer is still
HTTP 200 with `{"gpus": [], "count": 0, "error": "<reason>"}`.

### GET /api/status
Live state of everything:

```json
{
  "version": "0.5.4",
  "host_uptime": 123456.7,
  "services": [
    {
      "id": "comfyui", "name": "ComfyUI", "active": true,
      "multi_instance": true, "max_instances": 4, "default_port": 8188,
      "unit_template": "comfy@{i}",
      "instances": [
        {"id": "comfy-0", "service": "comfyui", "name": "ComfyUI #0",
         "port": 8188, "gpu": 0, "gpus": [0], "up": true, "uptime": 169000.0},
        {"id": "comfy-1", "service": "comfyui", "name": "ComfyUI #1",
         "port": 8189, "gpu": 1, "gpus": [1], "up": true, "uptime": 168000.0},
        {"id": "comfy-dual", "service": "comfyui", "name": "comfy-dual",
         "port": 8190, "gpu": null, "gpus": [0, 1], "up": false,
         "uptime": null}
      ]
    },
    {
      "id": "aitoolkit", "name": "AI Toolkit", "active": true,
      "multi_instance": false, "max_instances": 1, "default_port": 8675,
      "unit": "ai-toolkit.service",
      "instances": [
        {"id": "aitoolkit", "service": "aitoolkit", "name": "AI Toolkit",
         "port": 8675, "gpu": null, "gpus": [], "up": true, "uptime": 180000.0}
      ]
    }
  ]
}
```

Stopped instances stay listed with `"up": false, "uptime": null` (a freshly
deployed multi-instance service always lists its default `comfy-0`; config
declared extra instances always stay listed too).

### GET /api/services
Same shape as `/api/status.services` but **detailed**: each instance additionally
has `"unit"` (systemd unit) and `"live"` (probe result boolean).

### GET /api/services/{svc}
One service, same detailed shape as one element above. 404 →
`{"error": "unknown service 'x'"}`.

### POST /api/services/{svc}/start
Idempotent: ensures the service's **default instance is up** (`comfy-0` /
`aitoolkit`). Result is `"started"` or `"already-running"`.

```json
{"action": "start", "result": "started", "service": {…same shape as GET /api/services/{svc}…}}
```

### POST /api/services/{svc}/stop[?force=1]
Stops **ALL** active instances of the service, then **forgets** every spawned
or non-default roster instance of that service automatically (v0.5.4):
the same bookkeeping as the forget endpoint drops the spawn-state entries
(config-declared extra instances are kept; the default index-0 instance is
never forgotten). The service therefore shows **cleanly down** afterwards —
only the default instance remains, listed as the single `up:false` row.
Without `?force=1` it refuses with **409** if any ComfyUI instance has a
generation running
(`{"error": "generation running: comfy-0 (1); pass ?force=1 to stop anyway"}`).

```json
{"action": "stop", "result": "stopped", "stopped": ["comfy-0", "comfy-1", "comfy-2"],
 "forgotten": ["comfy-1", "comfy-2"], "service": {…}}
```

- `stopped`: ids of the instances that were running and got stopped.
- `forgotten`: ids whose listing was removed (spawn-state dropped) — every
  spawned/non-default roster instance, running or merely remembered down.
  The default instance (`comfy-0`) always stays listed (`up:false`).

`result` is `"already-stopped"` (with empty `stopped`) when nothing was
active; the forget-cleanup still runs in that case. (v0.6.0: the forget
cleanup also removes the runtime GPU drop-ins of all forgotten stopped
indexes — `/run/systemd/system/comfy@<i>.service.d/` left empty.)

The per-instance endpoint `POST /api/services/{svc}/instances/{id}/stop`
keeps its old semantics — **no auto-forget**: a stopped single instance
stays listed as `up:false`; users stop-and-keep one instance on purpose.
(v0.6.0: a pinned GPU drop-in is removed on stop; the next start of this
instance re-creates it from spawn-state.)

### POST /api/services/{svc}/instances  (spawn)
Multi-instance services only. Optional JSON body (v0.6.0):
`{"gpus": [1]}` (single GPU) or `{"gpus": [0, 1]}` (multi-GPU). No body →
the modulo default.

- **Validation** (invalid → **400** `{"error": …}`): body must be a JSON
  object; `gpus` must be a **non-empty array of unique integers** and every
  index must exist on the host (live `NUM_GPUS` via `nvidia-smi -L`, e.g.
  `"gpus": [2]` on a 2-GPU host → 400). An empty object `{}` behaves like no
  body. Non-object / non-JSON bodies → 400.
- **Index/port unchanged**: lowest free index, port = `8188+i`.
- **With `gpus`**: the set is written as a runtime drop-in
  (`/run/systemd/system/comfy@<i>.service.d/override.conf` →
  `Environment=ARTHUR_GPUS="<list>"`) + `daemon-reload` **before** start,
  and recorded in spawn-state; the multi-GPU case launches with
  `--cuda-device 0,1`. A failed start removes the pin again.
- **Without body**: `gpus = [i % NUM_GPUS]` (v0.5.x behavior, no drop-in;
  a stale pin on the chosen index is cleared), and the spawn-state record
  is cleared to the modulo default.

```json
POST /api/services/comfyui/instances  {"gpus": [0, 1]}
{"action": "spawn", "result": "spawned",
 "instance": {"id": "comfy-2", "service": "comfyui", "name": "ComfyUI #2",
              "port": 8190, "gpu": null, "gpus": [0, 1], "unit": "comfy@2",
              "up": true, "live": true, "uptime": 1.2}}
```

(`gpu`: `gpus[0]` iff the array has exactly one element, else `null`.)

- Index = lowest inactive index in `0..max-1`; port = `8188+i`; `gpus` per
  the spawn body (or `[i % NUM_GPUS]` default); `gpu` = `gpus[0]` iff one
  GPU. **Extra instances do not consume spawn indexes.**
- Single-instance service → **409 `{"error": "single-instance service"}`**.
- All indexes active → **409 `{"error": "max instances reached (4)"}`**.
- Unit start failed → 500; unit up but port never served → 502.

### GET /api/services/{svc}/instances
`{"service": "comfyui", "instances": [ {instance detail}, … ]}`

### GET /api/services/{svc}/instances/{id}[ /status]
Live detail for one instance (both spellings accepted):

```json
{"id": "comfy-1", "service": "comfyui", "name": "ComfyUI #1", "port": 8189,
 "gpu": 1, "gpus": [1], "unit": "comfy@1", "up": true, "live": true,
 "uptime": 1234.5}
```

Extra instances resolve by their config id (e.g. `comfy-dual`) and behave
identically here — `unit` is their declared unit, `gpus` their declared list,
`gpu` null when more than one GPU.

### POST /api/services/{svc}/instances/{id}/start
Idempotent start of ONE instance (`already-running` if active).
→ `{"action": "start", "result": "started", "instance": {…detail…}}`

### POST /api/services/{svc}/instances/{id}/stop[?force=1]
Graceful stop of ONE instance: **409** if a generation is running unless
`?force=1`. → `{"action": "stop", "result": "stopped", "instance": {…}}`

### POST /api/services/{svc}/instances/{id}/restart[?force=1]
Stop → wait port free (≤30 s) → start → wait port serving (≤90 s).
→ `{"action": "restart", "result": "restarted", "instance": {…}}`

### POST /api/services/{svc}/instances/{id}/forget  (v0.5.3)
Forget a **STOPPED** instance — remove it from the agent's world so it stops
appearing in status/instance lists:

```json
{"action": "forget", "result": "forgotten", "id": "comfy-2"}
```

- **Spawned instance** (`comfy-2`): deleted from the spawn-state file
  (`/var/lib/arthur-agent/instances.json`) — its index/port become free for
  the next spawn — and its runtime GPU drop-in (if any) is removed
  (+ `daemon-reload`, v0.6.0).
- **Config-declared extra instance** (e.g. `comfy-dual`): the entry is
  removed from `/etc/arthur-agent/config.json` (atomic rewrite, file stays
  valid, rest untouched) and the live registry hot-reloads — after a forget
  the instance is gone until it is re-added to the config.
- **Default instance** (index 0, `comfy-0` / `aitoolkit`) is never
  forgettable → **409** `{"error": "default instance cannot be forgotten"}`.
- **Running instance** → **409** `{"error": "instance is running"}` (stop it
  first).
- Unknown id → **404** `{"error": "unknown instance 'x' of service 'comfyui'"}`.
- Single-instance services only ever have the default instance, so forget
  always 409s there.
- Every forget attempt (success or refusal) lands in the audit log.

### GET /api/log?offset=N
Byte-offset tail of the JSONL audit log:
`{"offset": N, "next_offset": M, "lines": ["{…}", …]}`.
Each mutation line: `{"ts", "service", "instance", "action", "result",
"source-ip"}` (`instance` is `null` for service-level actions).

### Removed in v0.5.0 (breaking)
The v0.4 fixed-instance endpoints `GET /api/instances`,
`/api/instances/{id}/status` and `POST /api/instances/{id}/start|stop|restart`
are gone — use the `/api/services/...` surface above (instance ids are the
same: `comfy-0`, `comfy-1`, `aitoolkit`).

## Security notes

- **LAN bind, token-gated.** The agent listens on `0.0.0.0:8766` so any device
  on the home network can call it; everything under `/api/` requires the
  Bearer token (`/etc/arthur-agent/env` / `token`). Deliberate tradeoff for a
  single-user home network: if the box is ever exposed beyond the LAN, switch
  `ARTHUR_AGENT_BIND=127.0.0.1` and proxy.
- Token + env file are `root:root 0600`; the token never appears in the repo.
- **No request data in shell commands.** Service/instance ids are validated
  against the registry (and `^[a-z0-9-]+$`); units/ports/probes are always
  computed from config.json. `comfy@.service` / `comfy-dual.service` are the
  only code-execution paths (plus the read-only `nvidia-smi` GPU probes: a
  cached `-L` count and the per-GPU stats query behind `/api/gpus`). All
  subprocess calls use 30 s timeouts (`/api/gpus`: 5 s). Spawn index selection
  is lock-protected.
- **Spawn request bodies are parsed, never executed.** The optional `gpus`
  body is validated (non-empty, unique integers < live NUM_GPUS → else 400)
  and only ever rendered into a systemd drop-in file
  (`Environment=ARTHUR_GPUS="<list>"`) under
  `/run/systemd/system/comfy@<i>.service.d/` — the unit name comes from the
  registry, never from the request. Bodies are capped (16 KiB).
- The agent unit runs as root (it must control system units) and is hardened
  with `NoNewPrivileges`, `ProtectSystem=full` and `KillMode=process`. Since
  v0.8.0 the spawn path needs `ProtectHome=no` (the spawned pi must write
  the user's `~/.pi`) and no `PrivateTmp` (the spawned tmux socket lives in
  the real `/tmp/tmux-<uid>/` so the user can attach), and spawned
  sessions survive agent restarts (`KillMode=process`). Audit log:
  `/var/log/arthur-agent/audit.jsonl`; spawn-state:
  `/var/lib/arthur-agent/instances.json`.
- **pi tail sandbox (v0.7.0).** The `/api/pi/sessions/{d}/{id}/tail` endpoint
  reads files only: the JSONL path comes from the pi-sync status file (not the
  request) and is accepted only after `realpath()` resolve proves it sits
  directly under `/home/*/.pi/agent/sessions/` (403 otherwise) — symlink
  escapes and tampered status paths fail closed. Session files are opened
  read-only; nothing under the pi-sync repo or sessions tree is ever written
  by the agent.
- **pi dir listing / spawn (v0.8.0).** Device identity comes from config —
  request paths can never name a device the config doesn't know (404) or a
  path outside its prefix allowlist (400), `..` segments are rejected before
  anything is touched, and every remote shell command goes through
  `-o BatchMode=yes` ssh (no interactive prompts possible). Request data that
  does reach a shell (`cwd`/`path`) is interpolated only via
  `shlex.quote()`-wrapped arguments of validated, allowlisted, absolute,
  dot-segment-free paths. Spawns run as the config-declared local `user`
  (uid/gid drop inside the agent's own child setup — no setuid binaries,
  `NoNewPrivileges` stays on); the agent's own ssh key for remote targets
  lives at `/root/.ssh/id_ed25519` and target hosts authorize it explicitly.
  Every spawn/refusal is audited.
- **pi-ahp-tty terminal spawn (v0.8.2).** Same v0.8.0 device/ssh/allowlist
  scaffold — `cwd` is allowlist-validated and `shlex.quote()`-wrapped before
  reaching the launcher shell; the only request-influenced subprocess
  argument is `--working-dir <cwd>` (the CLI path is resolved from the
  config-declared user's home, never from the request). Availability is
  probed before anything is spawned (422, no-op, when the tool is absent).
  The launched supervisor is detached (nohup + background) so it survives
  the HTTP call and agent restarts; it runs as the config-declared local
  `user` on `self` devices and over BatchMode ssh on remote ones. No new
  deps; the audit log gains `terminal-spawn` entries.

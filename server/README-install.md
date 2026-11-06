# arthur-agent — server install (one page)

`server/` holds the pieces that run on the arthur home server (the machine
hosting ComfyUI + ai-toolkit), not the Obsidian plugin itself:

| file                  | deploy target                          | purpose |
|-----------------------|----------------------------------------|---------|
| `arthur-agent.py`     | `/opt/arthur-agent/arthur-agent.py`    | companion agent: service registry, dynamic instances, lifecycle control, audit log |
| `config.json`         | `/etc/arthur-agent/config.json`        | the service registry (schema v2, below) |
| `comfy@.service`      | `/etc/systemd/system/comfy@.service`   | multi-instance ComfyUI template unit: port = `8188+i`, GPU = `i % NUM_GPUS` (computed at start) |
| `arthur-agent.service`| `/etc/systemd/system/arthur-agent.service` | agent unit, listens on `0.0.0.0:8766` |

The agent is a **single-file Python 3 stdlib server** (no pip deps, v0.5.0).
It exposes a *service registry* — services are defined once in config.json and
instances are **computed**, never stored from requests. Request data is never
interpolated into shell commands; the agent only ever runs `systemctl
start/stop/is-active|show <unit-from-config>` and `nvidia-smi -L`, all with
subprocess timeouts. Every mutation appends one JSON line to the audit log.

## Semantics (v0.5.0 model)

- **Service** = a systemd-managed app from the registry. Two kinds:
  - `multi_instance: true` (comfyui): runs a **template unit** `comfy@{i}`.
    Instance *i* listens on `default_port + i`, uses GPU `i % NUM_GPUS`
    (NUM_GPUS detected live via `nvidia-smi -L` at each status/spawn).
    Instance ids are `<instance_prefix>-<i>`, e.g. `comfy-0`, `comfy-2`.
  - `multi_instance: false` (aitoolkit): exactly one instance, id = service id
    (`aitoolkit`), fixed unit `ai-toolkit.service`. **Spawning returns 409** —
    ai-toolkit has shared SQLite state and must never be duplicated.
- **Default instance** = index 0 (`comfy-0` / `aitoolkit`). Service
  start/stop operate on it (start) or all instances (stop).
- **Spawn** picks the lowest index in `0..max_instances-1` whose unit is not
  currently active. A stopped spawned instance's port/id may be reused by the
  next spawn. Instance indexes remembered as *spawned* persist (state file)
  so the instance stays listed while stopped.
- **`up`** = systemd unit active **and** the instance answers HTTP 200 on its
  `probe_path` (`/system_stats` for ComfyUI, `/` for ai-toolkit).
- **`active`** (service level) = any instance up.

## Deploy (v0.5.0)

```sh
sudo install -m 755 arthur-agent.py /opt/arthur-agent/arthur-agent.py
sudo install -m 644 config.json /etc/arthur-agent/config.json
sudo install -d -m 755 /var/lib/arthur-agent          # spawn-state file
sudo install -m 644 comfy@.service arthur-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart arthur-agent
curl -s http://127.0.0.1:8766/health   # → {"ok": true, "version": "0.5.0"}
```

Token lives in `/etc/arthur-agent/token` (root 0600) and `/etc/arthur-agent/env`
(`ARTHUR_AGENT_TOKEN=…`, `ARTHUR_AGENT_BIND=0.0.0.0`, `ARTHUR_AGENT_PORT=8766`).
Migrating from v0.4 config keeps the token unchanged; the plugin uses the same
token.

## config.json — schema v2 (/etc/arthur-agent/config.json)

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
      "probe_path": "/system_stats"
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
| `probe_path` | HTTP path used for the liveness probe (default `/`) |
| `num_gpus` | fallback GPU count if `nvidia-smi -L` fails |
| `bind` / `port` | optional; `ARTHUR_AGENT_BIND` / `ARTHUR_AGENT_PORT` env win |

---

## API surface (v0.5.0 — FINAL; plugin code targets exactly this)

`GET /health` is unauthenticated. **Everything under `/api/` requires
`Authorization: Bearer <token>`.** All responses are JSON; errors are always
`{"error": "message"}` with a fitting HTTP code.

### GET /health (no auth)
`{"ok": true, "version": "0.5.0"}`

### GET /api/status
Live state of everything:

```json
{
  "version": "0.5.0",
  "host_uptime": 123456.7,
  "services": [
    {
      "id": "comfyui", "name": "ComfyUI", "active": true,
      "multi_instance": true, "max_instances": 4, "default_port": 8188,
      "unit_template": "comfy@{i}",
      "instances": [
        {"id": "comfy-0", "service": "comfyui", "name": "ComfyUI #0",
         "port": 8188, "gpu": 0, "up": true, "uptime": 169000.0},
        {"id": "comfy-1", "service": "comfyui", "name": "ComfyUI #1",
         "port": 8189, "gpu": 1, "up": true, "uptime": 168000.0}
      ]
    },
    {
      "id": "aitoolkit", "name": "AI Toolkit", "active": true,
      "multi_instance": false, "max_instances": 1, "default_port": 8675,
      "unit": "ai-toolkit.service",
      "instances": [
        {"id": "aitoolkit", "service": "aitoolkit", "name": "AI Toolkit",
         "port": 8675, "gpu": null, "up": true, "uptime": 180000.0}
      ]
    }
  ]
}
```

Stopped instances stay listed with `"up": false, "uptime": null` (a freshly
deployed multi-instance service always lists its default `comfy-0`).

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
Stops **ALL** active instances of the service. Without `?force=1` it refuses
with **409** if any ComfyUI instance has a generation running
(`{"error": "generation running: comfy-0 (1); pass ?force=1 to stop anyway"}`).

```json
{"action": "stop", "result": "stopped", "stopped": ["comfy-0", "comfy-1"], "service": {…}}
```

`result` is `"already-stopped"` (with empty `stopped`) when nothing was active.

### POST /api/services/{svc}/instances  (spawn)
Multi-instance services only:

```json
{"action": "spawn", "result": "spawned",
 "instance": {"id": "comfy-2", "service": "comfyui", "name": "ComfyUI #2",
              "port": 8190, "gpu": 0, "unit": "comfy@2", "up": true,
              "live": true, "uptime": 1.2}}
```

- Index = lowest inactive index in `0..max-1`; port = `8188+i`;
  gpu = `i % NUM_GPUS` (live-detected).
- Single-instance service → **409 `{"error": "single-instance service"}`**.
- All indexes active → **409 `{"error": "max instances reached (4)"}`**.
- Unit start failed → 500; unit up but port never served → 502.

### GET /api/services/{svc}/instances
`{"service": "comfyui", "instances": [ {instance detail}, … ]}`

### GET /api/services/{svc}/instances/{id}[ /status]
Live detail for one instance (both spellings accepted):

```json
{"id": "comfy-1", "service": "comfyui", "name": "ComfyUI #1", "port": 8189,
 "gpu": 1, "unit": "comfy@1", "up": true, "live": true, "uptime": 1234.5}
```

### POST /api/services/{svc}/instances/{id}/start
Idempotent start of ONE instance (`already-running` if active).
→ `{"action": "start", "result": "started", "instance": {…detail…}}`

### POST /api/services/{svc}/instances/{id}/stop[?force=1]
Graceful stop of ONE instance: **409** if a generation is running unless
`?force=1`. → `{"action": "stop", "result": "stopped", "instance": {…}}`

### POST /api/services/{svc}/instances/{id}/restart[?force=1]
Stop → wait port free (≤30 s) → start → wait port serving (≤90 s).
→ `{"action": "restart", "result": "restarted", "instance": {…}}`

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
  computed from config.json. `comfy@.service` is the only code-execution path
  (plus the read-only `nvidia-smi -L` GPU probe). All subprocess calls use
  30 s timeouts. Spawn index selection is lock-protected.
- The agent unit runs as root (it must control system units) and is hardened
  with `NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome=read-only`,
  `PrivateTmp`. Audit log: `/var/log/arthur-agent/audit.jsonl`; spawn-state:
  `/var/lib/arthur-agent/instances.json`.

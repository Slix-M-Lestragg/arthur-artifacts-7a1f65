# arthur-agent — server install (one page)

`server/` holds the pieces that run on the arthur home server (the machine
hosting ComfyUI + ai-toolkit), not the Obsidian plugin itself:

| file                  | deploy target                          | purpose |
|-----------------------|----------------------------------------|---------|
| `arthur-agent.py`     | `/opt/arthur-agent/arthur-agent.py`    | companion agent: lifecycle control, status, audit log |
| `comfy@.service`      | `/etc/systemd/system/comfy@.service`   | template unit: `comfy@0` = GPU 0/port 8188, `comfy@1` = GPU 1/port 8189 |
| `arthur-agent.service`| `/etc/systemd/system/arthur-agent.service` | agent unit, listens on `0.0.0.0:8766` |

The agent is a **single-file Python 3 stdlib server** (no pip deps). It maps
fixed instance ids to systemd units — request data is never interpolated into
shell commands — and appends one JSON line per action to its audit log.

## Deploy

```sh
sudo install -m 755 arthur-agent.py /opt/arthur-agent/arthur-agent.py
sudo install -d -m 755 /etc/arthur-agent
sudo install -m 644 comfy@.service arthur-agent.service /etc/systemd/system/

# token — generate a strong random secret, referenced from the env file
sudo sh -c 'openssl rand -hex 32 > /etc/arthur-agent/token && chmod 600 /etc/arthur-agent/token'
TOK=$(sudo cat /etc/arthur-agent/token)
printf 'ARTHUR_AGENT_TOKEN=%s\nARTHUR_AGENT_BIND=0.0.0.0\nARTHUR_AGENT_PORT=8766\n' "$TOK" \
  | sudo sh -c 'cat > /etc/arthur-agent/env && chmod 600 /etc/arthur-agent/env'
```

`/etc/arthur-agent/config.json` — the agent's instance registry (the only
place instance ids/units/ports are defined; ids must match `[a-z0-9-]`):

```json
{
  "instances": {
    "comfy-0": { "name": "ComfyUI GPU0", "port": 8188, "gpu": 0, "unit": "comfy@0.service" },
    "comfy-1": { "name": "ComfyUI GPU1", "port": 8189, "gpu": 1, "unit": "comfy@1.service" }
  }
}
```

Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now comfy@0 comfy@1 arthur-agent
curl -s http://127.0.0.1:8766/health          # → {"ok": true, "version": "0.4.0"}
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:8766/api/status
```

The plugin (Obsidian side) uses the **same token** in its settings: `host`,
`agentPort` 8766, `agentToken` `$TOK`.

## API (all `/api/*` require `Authorization: Bearer <token>`)

- `GET /health` — unauthenticated liveness `{ok, version}`
- `GET /api/status` — agent version, per-instance `{id,name,port,gpu,up,uptime}`, host uptime
- `GET /api/instances` — the registry
- `GET /api/instances/{id}/status` — adds a port liveness probe (`live`) against `/system_stats`
- `POST /api/instances/{id}/start` — idempotent (`already-running` if active)
- `POST /api/instances/{id}/stop` — 409 if a generation is running unless `?force=1`
- `POST /api/instances/{id}/restart` — stop → wait port free (≤30 s) → start
- `GET /api/log?offset=N` — byte-offset tail of the JSONL audit log
  (`ts`, `instance`, `action`, `result`, `source-ip` per line)

Errors are always structured JSON: `{"error": "message"}` with a fitting HTTP code.

## Security notes

- **LAN bind, token-gated.** The agent listens on `0.0.0.0:8766` so any device
  on the home network (the Obsidian machine) can call it; everything under
  `/api/` requires the Bearer token from `/etc/arthur-agent/env`/`token`.
  This is a deliberate tradeoff for a single-user home network: if the box is
  ever exposed beyond the LAN, switch `ARTHUR_AGENT_BIND=127.0.0.1` and proxy.
- Token + env file are `root:root 0600`; the token never appears in the repo.
- Instance ids are validated against the fixed allowlist in `config.json`;
  the agent only ever runs `systemctl start/stop/is-active|show <unit-from-config>`,
  with 30 s subprocess timeouts. `comfy@.service` is the only code execution path.
- The agent unit runs as root (it must control system units via systemd) and is
  hardened with `NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome=read-only`,
  `PrivateTmp`. Audit log: `/var/log/arthur-agent/audit.jsonl`.

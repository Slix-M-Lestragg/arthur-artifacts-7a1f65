# arthur — Project Plan

**TL;DR:** `arthur` is a desktop-only Obsidian plugin that lets the user drive AI workloads on a LAN home server (2× RTX 3060, Ubuntu) from a dashboard: monitor ComfyUI generation (queue, progress, VRAM) and ai-toolkit training (steps, loss, GPU), control jobs, and start/stop/restart ComfyUI instances via a tiny Python companion agent (`arthur-agent`) running under systemd on the server. The plugin stays a **pure HTTP/WS client** (TypeScript, esbuild, plain DOM, no React in v1). Repo: `dev` branch carries all source/docs; `main` carries only compiled artifacts (`main.js`, `manifest.json`, `styles.css`), installed on the Obsidian machine by git-pulling `main` into `.obsidian/plugins/arthur/`.

---

## 1. Feature Set by Phase

### v0.1 — Dashboard & Monitoring (read-only)
- Server/device overview: GPU count, VRAM total/free per GPU — ComfyUI `GET /system_stats` (`devices[].vram_total/vram_free`) on 8188/8189
- Generation queue: running + pending prompts, queue depth — `GET /queue`
- Job list with status filter + pagination — `GET /api/jobs?status=…`
- Live step progress of running generation — WS `progress` event; fallback to polling `/queue`
- Execution state transitions — WS events `execution_start`, `executing`, `executed`, `execution_success`, `execution_error`, `execution_interrupted`
- Training job table: name, GPU set, step/total_steps, speed, queue position, pid, status — ai-toolkit `GET /api/jobs`
- Status bar pill: compact GPU VRAM + queue depth + training activity
- Multi-server profile support (host + ports + tokens) in plugin settings

**Done when:** user opens the arthur view from the ribbon and sees live VRAM, queue contents, generation progress, and the training table updating automatically, and the status bar pill stays fresh while the view is closed.

### v0.2 — Job Control (write operations, no instance lifecycle)
- Cancel a pending/running generation prompt — `POST /interrupt` with `prompt_id`; bulk clear via `POST /queue {clear:true}`
- Delete selected queued prompt IDs — `POST /queue` with `delete:[ids]`
- Free VRAM / unload models button per instance — `POST /free`
- Stop / kill a training job — `GET /api/jobs/{id}/stop` (graceful) / `/kill` (force)
- Mark a crashed job stopped — `GET /api/jobs/{id}/mark_stopped`
- Delete a training job — `GET /api/jobs/{id}/delete`
- Force checkpoint save / sample now — `/api/jobs/{id}/save_now` / `/sample_now`
- Start a training job — `GET /api/jobs/{id}/start`
- Queue-level pause/resume — `GET /api/queue/{id}/stop|start`
- Confirmation Modals for destructive ops, Notice toasts, immediate re-poll after mutations

**Done when:** every listed control works from the dashboard with confirmation, and state reflects the mutation within one poll cycle.

### v0.3 — Instance Lifecycle via Companion Agent
- Start / stop / restart ComfyUI instances (comfy-0 on 8188, comfy-1 on 8189) — agent `POST /api/instances/{id}/start|stop|restart`
- Instance runtime status — agent `GET /api/instances` + `GET /api/instances/{id}/status`, cross-checked against `/system_stats` liveness
- "Run on dedicated GPU" — agent config maps instance → launch command with fixed `CUDA_VISIBLE_DEVICES=<n> --port`; start may carry a validated variant id
- Shared Bearer token auth (agent env token, plugin settings token)
- Audit trail — agent appends JSON lines to audit log; `GET /api/log?offset=` tail
- Agent `/api/status` handshake gates lifecycle UI (unreachable → buttons disabled)

ai-toolkit's own service lifecycle stays managed by the user outside arthur for v1.

**Done when:** the user can start an instance on a chosen GPU, stop it, restart it, from Obsidian without SSH.

### v0.4 — Nice-to-haves
- Live preview strip (mid-generation JPEGs) — WS binary frames → blob `<img>` ring buffer
- Loss chart for training runs — `GET /api/jobs/{id}/loss?since_step=` incremental fetch + hand-rolled SVG line chart
- Incremental training log tail — `GET /api/jobs/{id}/log?offset=`
- Sample gallery per job — `GET /api/jobs/{id}/samples`
- Output image browsing — ComfyUI `GET /view` + `/history`
- Insert generated image into the open note — `GET /view` → `app.vault.createBinary`
- SSE live server metrics — ai-toolkit `GET /api/monitor` SSE, poll `/api/gpu` `/api/cpu` fallback
- Dataset listing + upload — `/api/datasets/list`, `/api/datasets/upload`
- Workflow submit from Obsidian — `POST /prompt` (defer; only if wanted)

## 2. Architecture

### 2.1 Plugin module layout (dev branch, src/)
```
src/
  main.ts               — plugin entry: register view, ribbon, status bar, intervals, settings
  settings.ts           — PluginSettingTab; profiles: [{name, host, comfyPorts:[8188,8189],
                          aiToolkitPort:8675, agentPort:8766, agentToken, aiToolkitToken}]
  api/
    comfy.ts            — ComfyUIClient per port: systemStats(), queue(), jobs(), interrupt(),
                          deleteQueue(), free(), models(), view(), history(); connectWs(clientId)
    aitoolkit.ts        — AiToolkitClient: jobs(), jobStart/Stop/Kill/Delete/MarkStopped(),
                          jobLog(offset), jobLoss(sinceStep), queueGet/Start/Stop(), gpu(), cpu();
                          Bearer auth header
    agent.ts            — ArthurAgentClient: status(), instances(), start/stop/restart(id); Bearer auth
  connection.ts         — WsConnection: wraps window.WebSocket, auto-reconnect exponential backoff
                          (1s→30s cap), status enum surfaced to UI
  poller.ts             — central poller (plugin.registerInterval): one tick fans out to collectors;
                          per-view visibility gating; per-endpoint in-flight guard; "poll now" hook
  ui/
    dashboard-view.ts   — ItemView: sections: instances, ComfyUI queue & progress, training table
    status-bar.ts       — compact "G0 12.3G ▸ G1 4.0G · q2 · 🏃train" line
    actions.ts          — Modal confirm wrapper + Notice helpers + mutation-then-repoll glue
  util.ts               — formatting (bytes, durations), tiny DOM helper el()
```
Boundaries: api/* clients know only HTTP/WS shapes; poller owns scheduling; ui/* owns rendering; main.ts wires everything.

Poll cadence: status bar light cycle 10–15s (system_stats + queue + jobs summary); dashboard detail cycle 2–3s while visible; WS gives sub-second progress.

### 2.2 Companion agent (arthur-agent)
Single-file Python 3 stdlib HTTP server (ThreadingHTTPServer, zero pip deps), ~200–400 lines, unprivileged user, systemd unit `arthur-agent.service` (Restart=on-failure). Config file maps instance ids → actions:
```
instances:
  comfy-0: port 8188, gpu 0, start = systemctl start comfy@0.service (or launch script)
  comfy-1: port 8189, gpu 1, …
```
Ships a sample `comfy@.service` unit templating `CUDA_VISIBLE_DEVICES` per instance.

Endpoints (all Bearer-token checked under /api/):
- GET /api/status — {version, instances:[{id, up, uptime, port, gpu}], host_uptime}
- GET /api/instances — registry
- GET /api/instances/{id}/status — runtime status incl. port liveness probe
- POST /api/instances/{id}/start — idempotent
- POST /api/instances/{id}/stop — graceful; refuse if a generation is running unless ?force=1 (agent checks GET /queue on that port)
- POST /api/instances/{id}/restart — stop → wait for port free → start, bounded timeout
- GET /api/log?offset= — audit tail (one JSON line per action)
- GET /health — unauthenticated {ok:true} to distinguish "agent down" from "bad token"

Security: LAN bind with token; fixed instance-id allowlist (never interpolate request data into shell commands); 30s subprocess timeouts; structured errors.

### 2.3 Failure modes
| Failure | Behavior |
|---|---|
| Server/agent down | Profile marked offline (red dot), backoff retries, lifecycle disabled, one transition Notice |
| One ComfyUI instance down | That panel grays out "not responding"; rest works; "start" suggested if agent present |
| WS drop mid-generation | Auto-reconnect with fresh clientId; re-poll /queue + /history to resync |
| Overlapping slow requests | Poller in-flight guard skips tick |
| ai-toolkit 401 | Distinct "bad token" state pointing at settings |
| Mutation error | Notice with server message; never optimistically update UI |
| Job ended | Clear progress on terminal WS events |
| Agent version mismatch | Banner suggesting server/ update |

## 3. Repo & Branch Strategy

dev branch (default, everything): README.md, manifest.json, versions.json, package.json, tsconfig.json, esbuild.config.mjs, .gitignore, src/, styles.css, server/, docs/, research/.
main branch (bare compiled artifacts ONLY): main.js, manifest.json, versions.json, styles.css, INSTALL.md. Nothing else — the user's .obsidian/plugins/arthur checkout must be exactly the set of files Obsidian reads.

Release flow dev → main: bump version in manifest + versions.json → production build → release script copies ONLY the artifacts onto main → tag v0.x.y on main. scripts/release.mjs automates this; it must never merge dev's other files into main.

.gitignore (dev): node_modules/, build/, main.js (root), *.map, .DS_Store, local test vault.

Install/update on Obsidian machine: git clone -b main <repo> <vault>/.obsidian/plugins/arthur; enable in Obsidian; update = git pull. No BRAT. No in-plugin update checks.

## 4. Build / Dev Workflow
- Dev loop: esbuild watch → build/main.js; copy into a test vault's .obsidian/plugins/arthur/main.js and reload Obsidian (or Hot-Reload plugin) for live testing
- Type safety: strict tsconfig; tsc --noEmit as pre-build gate
- Testing: api clients thin over requestUrl; verify against the live server (8188/8189/8675); GUI testing via a Linux Obsidian sandbox instance on the server with a scratch vault (agent-os tooling available); pure functions tested with node assertions
- Versioning: semver in manifest + tag on main; minAppVersion tracks current Obsidian
- Toolchain identical to official obsidian-sample-plugin scaffold

## 5. Milestones
| # | Milestone | Effort | Done looks like |
|---|---|---|---|
| M0 | Scaffold & repo plumbing | 0.5d | Scaffold on dev, build passes, main branch = artifacts only, private repo pushed, settings tab with one server profile |
| M1 | ComfyUI & ai-toolkit API clients | 1d | comfy.ts/aitoolkit.ts typed + verified against live server |
| M2 | v0.1 dashboard & monitoring | 2–3d | Live VRAM/queue/progress/training table, status bar, reconnecting WS |
| M3 | v0.2 job control | 1–2d | All controls work with confirm + toasts + immediate refresh |
| M4 | arthur-agent | 1–2d | Python agent + systemd on server, curl-verified start/stop/restart |
| M5 | v0.3 lifecycle in plugin | 1–1.5d | Full start→generate→stop cycle purely from Obsidian |
| M6 | v0.4 nice-to-haves | 2–4d | Previews, loss chart, log tail, gallery, SSE metrics — pick per need |
| M7 | Polish & first tagged release | 1d | Tagged release on main, failure modes verified, docs complete |

Execution order: M0 → M1 → M2 → M3 → M4 → M5 → M7; pull M6 features forward when they make the tool nicer to live with (previews + loss chart are highest value).

Key decisions: plugin = pure HTTP/WS client (no native deps, isDesktopOnly); lifecycle via token-authed arthur-agent over systemd; monitoring talks directly to the service ports; TypeScript + plain DOM (no React, no new deps beyond scaffold); private repo, main = artifacts only, git-pull distribution; no outbound internet from the plugin.

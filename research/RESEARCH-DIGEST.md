# Arthur — Research Digest (2026-11-05)

Grounded against the LOCAL source of the actual server software (fresh ComfyUI master @ 5f415e3 checkout and ostris/ai-toolkit @ e9c72b7 checkout), plus platform knowledge of the Obsidian plugin ecosystem. Full research session transcripts are retained in the user's pi-agent session logs.

## ComfyUI HTTP API (ports 8188/8189)
- GET /system_stats → system block + devices[] with vram_total/vram_free per visible GPU
- GET /queue → {queue_running, queue_pending}; POST /queue {delete:[ids]} | {clear:true}
- GET /api/jobs (new paginated API) with ?status= & sort_by=; POST /api/jobs/{id}/cancel
- POST /prompt (submit workflow); POST /interrupt {prompt_id?} (targeted cancel)
- POST /free {unload_models, free_memory}; GET /models/{folder}; GET /view (output images); GET /history
- WS /ws?clientId= → JSON events: status, execution_start, executing, progress {value,max}, executed, execution_success, execution_error, execution_interrupted; binary frames = live preview JPEGs (protocol types 1/2/4)
- Per-GPU instances = CUDA_VISIBLE_DEVICES=<n> + --port. NO lifecycle endpoints exist — external control (companion agent) required.
- Lifecycle options ranked: (1) tiny companion HTTP agent on server backed by systemd/launch scripts — plugin stays pure HTTP client; (2) ssh2 bundled (external: cpu-features, key mgmt); (3) child_process spawning ssh CLI via window.require.

## ai-toolkit HTTP API (port 8675, Bearer AI_TOOLKIT_AUTH env)
- GET/POST /api/jobs — job row: {id, name, gpu_ids, job_config (JSON string), status queued|running|stopping|stopped|error|completed, step, total_steps, speed_string, queue_position, pid, job_type}
- GET /api/jobs/{id}/start | stop (graceful SIGINT) | kill (SIGKILL) | delete | mark_stopped | log?offset= (incremental tail, 5MB cap) | loss?since_step=N (chartable metric series, gzip) | samples | save_now | sample_now
- GET /api/queue, /api/queue/{id}/start | stop — per-GPU-set queues; worker sets CUDA_VISIBLE_DEVICES=gpu_ids and spawns venv run.py with AITK_JOB_ID env
- GET /api/gpu, /api/cpu (nvidia-smi); SSE GET /api/monitor (init + sample events: GPU/CPU/RAM)
- GET /api/datasets/list; POST /api/datasets/upload (multipart)
- Progress is POLLING ONLY (trainer writes status into shared SQLite). Control routes are GETs with side effects — keep them wrapped in a typed API client.
- Job config schema: {name, process:[{type:"sd_trainer", training_folder, device, network, save, datasets[], train, model, sample}]}

## Obsidian plugin platform
- Scaffold = official obsidian-sample-plugin (esbuild CJS bundle → main.js + manifest.json + styles.css)
- requestUrl bypasses CORS (main-process proxy) but no streaming; raw window.WebSocket works in desktop plugins (WS not CORS-blocked); EventSource/fetch-stream usable for SSE on desktop
- isDesktopOnly: true gives window.require access to node builtins on desktop
- UI: ItemView via registerView, addRibbonIcon, addStatusBarItem, Notice, PluginSettingTab, Modal; no built-in tables/charts — hand-rolled DOM for v1 (no React)
- Polling: plugin.registerInterval(window.setInterval(...)) auto-clears on unload; gate on view visibility; guard against overlapping in-flight requests
- Private distribution: git-clone -b main into .obsidian/plugins/arthur/ with prebuilt main.js committed is the most robust path (BRAT with PAT is finicky for private repos). No update checks in-plugin (LAN only, no outbound internet).

/**
 * Client for the arthur-agent companion service (server/README-install.md,
 * default port 8766) — API v0.5.2 service-registry surface. Services are
 * systemd-managed entries from the agent's config; instances are computed,
 * never stored. Everything under /api/ is Bearer-token authenticated; the
 * agent may legitimately be unreachable (server down, systemd restart) —
 * every failure surfaces as a typed ArthurApiError (status 0 for
 * network-level failures).
 */
import { ArthurApiError, Requester, ensureOk } from "./transport";

/**
 * One computed instance of a service — GET /api/status shape (live probe
 * booleans like `unit`/`live` only appear on the detailed /api/services/*).
 */
export interface AgentInstance {
	id: string;
	service: string;
	/** Friendly label from the agent's config.json (defaults to the id). */
	name?: string;
	port: number;
	/** GPU index the instance runs on; null for non-GPU services. */
	gpu: number | null;
	/** GPU index(es) the instance runs on (v0.5.2). Multi-GPU instances carry
	 *  the full list; `gpu` is `gpus[0]` when the list has one element, else null. */
	gpus?: number[];
	/** systemd active AND the port answers the probe path. */
	up: boolean;
	uptime?: number | null;
	unit?: string;
	/** The port answers the probe path with the instance's OWN install
	 *  (detailed ≤ 0.8.0 endpoints only; summarized on 0.8.1+). Externally
	 *  started own installs are live-but-unmanaged. */
	live?: boolean;
	/** Agent v0.8.1 — three orthogonal observability booleans beside `up`:
	 *  managed  = the systemd unit is active (even when the port is dead);
	 *  live     = the port serves the instance's OWN install (an externally
	 *             started own install is live-but-unmanaged);
	 *  foreign_occupied = the port answers but belongs to a DIFFERENT install
	 *             (live stays false) — render a warning chip on the down row.
	 *  Omitted on ≤ 0.8.0 agents: fall back to `up` for managed-ness. */
	managed?: boolean;
	foreign_occupied?: boolean;
}

/** One registered service with its live instance list. */
export interface AgentService {
	id: string;
	name?: string;
	/** Service-level state: agent v0.8.1 — any instance managed (unit active)
	 *  OR live (port serves its own install, even externally started).
	 *  ≤ 0.8.0: any instance up. */
	active: boolean;
	multi_instance: boolean;
	max_instances: number;
	default_port: number;
	/** multi_instance services only. */
	unit_template?: string;
	/** single-instance services only. */
	unit?: string;
	instances: AgentInstance[];
}

/** GET /api/status — agent version + full service/instance snapshot. */
export interface AgentStatus {
	version: string;
	host_uptime?: number;
	services: AgentService[];
}

/** One GPU as reported by GET /api/gpus (nvidia-smi, v0.5.2). */
export interface AgentGpu {
	index: number;
	name: string;
	mem_total_mb: number;
	mem_used_mb: number;
	util_percent: number;
	temp_c: number;
}

/** GET /api/gpus — degradable, not fatal: nvidia-smi failure → 200 with
 *  {gpus: [], error}. */
export interface AgentGpusResponse {
	gpus: AgentGpu[];
	count: number;
	error?: string;
}

/** GET /api/services/{svc}/instances — one service's instance list. */
export interface AgentServiceInstancesResponse {
	service: string;
	instances: AgentInstance[];
}

/** POST /api/services/{svc}/instances (spawn) — 201 with the new instance. */
export interface AgentSpawnResult {
	action: "spawn";
	result: string;
	instance: AgentInstance;
}

/** POST /api/services/{svc}/instances/{id}/forget — drop a stopped instance
 *  from the agent's service registry (200 {action:'forget', result:'forgotten'});
 *  409 {error:'instance is running'} while up, 404 unknown. */
export interface AgentForgetResult {
	action: "forget";
	result: "forgotten";
	id: string;
}

/**
 * POST /api/services/{svc}/stop — results over ALL active instances.
 * Agent v0.5.4: stop-all also FORGETS every non-default instance of the
 * service (config extras stay) — `forgotten` lists the instance ids dropped
 * from the registry. A v0.5.3 agent omits the field; treat as [] .
 */
export interface AgentServiceStopResult {
	action: "stop";
	result: string;
	stopped: string[];
	forgotten?: string[];
	service?: AgentService;
}

/** POST /api/services/{svc}/start + single-instance start/stop/restart. */
export interface AgentActionResult {
	action: string;
	result: string;
	stopped?: string[];
	instance?: AgentInstance;
	service?: AgentService;
}

/** Agent version this plugin build was written against — mismatch → banner.
 *  0.6.0: POST /api/services/{svc}/instances accepts an optional JSON body
 *  {"gpus": [n, …]} to pin the new instance to specific GPU(s) (no body = the
 *  modulo rotation, as before).
 *  0.7.0: pi observational surface — GET /api/pi/status (pi sessions +
 *  subagent runs per device) and GET /api/pi/sessions/{device}/{id}/tail.
 *  pi is NOT a managed service: no lifecycle endpoints, pure observation. */
export const AGENT_VERSION = "0.8.1";

/** Instance visibility rule (agent v0.8.1): render an instance row when it
 *  is managed (even down), live (externally started own install), or its
 *  port is held by a foreign install. Agents that report NO explicit flags
 *  (≤ 0.8.0) render every listed instance (legacy semantics). */
export function instanceRelevant(inst: AgentInstance): boolean {
	return inst.managed === undefined
		? true
		: inst.managed === true || inst.live === true || inst.foreign_occupied === true;
}

/** True when the instance is lifecycle-managed: the agent reports an explicit
 *  `managed` flag (v0.8.1), else (≤ 0.8.0) `up` implies the unit was active.
 *  Never used to DISABLE lifecycle controls — see dashboard-view (an explicit
 *  false is the only adoption signal). */
export function instanceManaged(inst: AgentInstance): boolean {
	return inst.managed ?? inst.up === true;
}

/** GET /health — unauthenticated {ok:true, version}; distinguishes "agent down" from "bad token". */
export interface AgentHealth {
	ok: boolean;
	version?: string;
}

// ------------------------------------------------------------- pi surface ----

/** One pi coding session of a device (GET /api/pi/status). */
export interface AgentPiSession {
	id: string;
	path: string;
	cwd: string;
	/** Friendly session name; absent → UI falls back to the last cwd segment. */
	name?: string | null;
	model?: string | null;
	provider?: string | null;
	/** ISO timestamps (any unparseable value is treated as absent by the UI). */
	startedAt?: string | null;
	lastActivity?: string | null;
	/** Session currently in use (drives queue placement: ACTIVE sessions only). */
	active: boolean;
	/** True while a turn executes (pi-arthur v0.1.6 producer contract).
	 *  Undefined on older producers → treat as active-only (idle). */
	running?: boolean;
}

/**
 * Structured plan/step progress of one subagent run (producer pi-arthur v0.1.7,
 * additive/optional — pre-0.1.7 feeds omit the field entirely; the producer
 * drops unusable payloads rather than fabricating values). Mirrors pi-agents'
 * `RunProgress`.
 */
export interface AgentPiSubProgress {
	/** Total planned steps — > 0 is what makes the bar trustworthy. */
	total: number;
	/** Completed steps; the UI clamps to [0, total]. */
	done: number;
	/** Current step label (producer-validated, ≤200 chars). */
	current?: string | null;
	/** Free-form progress note (producer-validated, ≤200 chars). */
	note?: string | null;
	/** ms epoch — refreshed on every progress update. */
	updatedAt?: number | null;
}

/** One pi subagent run (child job of its parentSessionId). */
export interface AgentPiSubagent {
	runId: string;
	batchId?: string | null;
	agent: string;
	taskPreview?: string | null;
	state: "running" | "done" | "failed" | "canceled";
	parentSessionId: string;
	startedAt?: string | null;
	finishedAt?: string | null;
	/** pi-arthur v0.1.7 additive optional fields (absent on older feeds — the
	 *  agent passes subagent dicts through verbatim):
	 *  progress     — structured done/total plan counts (drives the bar width)
	 *                 + current/note step text + updatedAt (ms epoch);
	 *  detail       — the producer's compact progress line (≤200 chars);
	 *  usage        — its formatted usage rollup (e.g. "3 turns ↑24k $0.008");
	 *  heartbeatAt  — ISO, restamped on every publish of this process's RUNNING
	 *                 runs; a stale one means the producer stopped publishing.
	 *                 Terminal runs never carry it. */
	progress?: AgentPiSubProgress | null;
	detail?: string | null;
	usage?: string | null;
	heartbeatAt?: string | null;
}

/** One pi-sync device (pi instances are NOT hardware-bound — they render
 *  above the GPU grid, and their active sessions slot into the job queue). */
export interface AgentPiDevice {
	device: string;
	hostname?: string | null;
	repoUpdatedAt?: string | null;
	sessionsCount?: number;
	activeSessions?: number;
	subagentsRunning?: number;
	sessions: AgentPiSession[];
	subagents: AgentPiSubagent[];
	/** Data snapshot past its freshness budget — UI paints a stale badge. */
	stale?: boolean;
}

/**
 * GET /api/pi/status — degradable observation: when the pi-sync status pipe
 * is absent the agent answers with an EMPTY devices list (never a hard
 * failure); the UI renders one muted 'pi status unavailable' line for that.
 */
export interface AgentPiStatus {
	devices: AgentPiDevice[];
	generatedAt?: string | null;
}

/** One tail entry of a session transcript (preview text only). */
export interface AgentPiTailLine {
	type: string;
	role?: string | null;
	preview?: string | null;
	timestamp?: string | null;
}

/** GET /api/pi/sessions/{device}/{sessionId}/tail?lines=N. */
export interface AgentPiTail {
	lines: AgentPiTailLine[];
}

export class ArthurAgentClient {
	constructor(
		private readonly host: string,
		private readonly port: number,
		private readonly token: string | null,
		private readonly requester: Requester,
	) {}

	get baseUrl(): string {
		return `http://${this.host}:${this.port}`;
	}

	private url(
		path: string,
		params?: Record<string, string | number | undefined>,
	): string {
		if (!params) return this.baseUrl + path;
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) search.set(key, String(value));
		}
		const query = search.toString();
		return this.baseUrl + path + (query ? `?${query}` : "");
	}

	private async call<T>(
		path: string,
		method: "GET" | "POST" = "GET",
		params?: Record<string, string | number | undefined>,
		body?: object,
	): Promise<T> {
		let resp;
		try {
			resp = await this.requester.request({
				url: this.url(path, params),
				method,
				headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
				body,
			});
		} catch (err) {
			// Transport-level failures never carry a URL of their own — tag the
			// attempt so offline diagnostics can name what was tried.
			if (err instanceof ArthurApiError) throw err;
			throw new ArthurApiError(
				this.url(path),
				0,
				err instanceof Error ? err.message : "request failed (network error)",
			);
		}
		await ensureOk(resp);
		return resp.json() as T;
	}

	/**
	 * GET /health — unauthenticated liveness probe. Rejections here mean the
	 * agent/process is down; 200 with {ok:true} means reachable (auth may still
	 * be wrong for /api/* routes).
	 */
	async health(): Promise<AgentHealth> {
		const resp = await this.requester.request({
			url: this.url("/health"),
		});
		await ensureOk(resp);
		return resp.json() as AgentHealth;
	}

	/** GET /api/status — version + full service/instance snapshot (gates all lifecycle UI). */
	async status(): Promise<AgentStatus> {
		return this.call<AgentStatus>("/api/status");
	}

	/** GET /api/gpus — live nvidia-smi stats; degrades to {gpus: [], error} on failure. */
	async gpus(): Promise<AgentGpusResponse> {
		return this.call<AgentGpusResponse>("/api/gpus");
	}

	/** GET /api/services/{svc}/instances — one service's instance list. */
	async serviceInstances(svc: string): Promise<AgentServiceInstancesResponse> {
		return this.call<AgentServiceInstancesResponse>(
			`/api/services/${encodeURIComponent(svc)}/instances`,
		);
	}

	/** POST /api/services/{svc}/start — idempotent start of the default instance. */
	async serviceStart(svc: string): Promise<AgentActionResult> {
		return this.call<AgentActionResult>(
			`/api/services/${encodeURIComponent(svc)}/start`,
			"POST",
		);
	}

	/**
	 * POST /api/services/{svc}/stop[?force=1] — stop ALL instances of the
	 * service AND forget every non-default one (v0.5.4); the server refuses
	 * with 409 while a generation runs unless force=true.
	 */
	async serviceStop(svc: string, force?: boolean): Promise<AgentServiceStopResult> {
		return this.call<AgentServiceStopResult>(
			`/api/services/${encodeURIComponent(svc)}/stop`,
			"POST",
			force ? { force: 1 } : undefined,
		);
	}

	/**
	 * POST /api/services/{svc}/instances — spawn a new instance (multi-instance
	 * services only; single-instance/max-reached → 409).
	 * Agent v0.6.0: `gpus` pins the new instance to specific GPU(s) as the JSON
	 * body {"gpus": [n, …]} (invalid sets → 400). Omitted/empty → the agent's
	 * modulo GPU rotation, as before.
	 */
	async serviceSpawn(svc: string, gpus?: number[]): Promise<AgentSpawnResult> {
		return this.call<AgentSpawnResult>(
			`/api/services/${encodeURIComponent(svc)}/instances`,
			"POST",
			undefined,
			gpus && gpus.length > 0 ? { gpus } : undefined,
		);
	}

	/** POST /api/services/{svc}/instances/{id}/start — idempotent start of ONE instance. */
	async instanceStart(svc: string, id: string): Promise<AgentActionResult> {
		return this.call<AgentActionResult>(
			`/api/services/${encodeURIComponent(svc)}/instances/${encodeURIComponent(id)}/start`,
			"POST",
		);
	}

	/** POST /api/services/{svc}/instances/{id}/stop[?force=1] — graceful stop of ONE instance. */
	async instanceStop(svc: string, id: string, force?: boolean): Promise<AgentActionResult> {
		return this.call<AgentActionResult>(
			`/api/services/${encodeURIComponent(svc)}/instances/${encodeURIComponent(id)}/stop`,
			"POST",
			force ? { force: 1 } : undefined,
		);
	}

	/** POST /api/services/{svc}/instances/{id}/restart[?force=1] — stop → start, bounded. */
	async instanceRestart(svc: string, id: string, force?: boolean): Promise<AgentActionResult> {
		return this.call<AgentActionResult>(
			`/api/services/${encodeURIComponent(svc)}/instances/${encodeURIComponent(id)}/restart`,
			"POST",
			force ? { force: 1 } : undefined,
		);
	}

	/**
	 * POST /api/services/{svc}/instances/{id}/forget — remove a STOPPED instance
	 * from the agent's registry so it no longer shows in /api/status. 409 while
	 * the instance is up (stop it first), 404 for an unknown id.
	 */
	async instanceForget(svc: string, id: string): Promise<AgentForgetResult> {
		return this.call<AgentForgetResult>(
			`/api/services/${encodeURIComponent(svc)}/instances/${encodeURIComponent(id)}/forget`,
			"POST",
		);
	}

	// ---------------------------------------------------------- pi surface ----

	/**
	 * GET /api/pi/status — observational pi-sync snapshot (sessions + subagent
	 * runs per device). Degradable: pipe absent → 200 with devices: [] (the
	 * UI renders its muted 'pi status unavailable' line), never thrown.
	 */
	piStatus(): Promise<AgentPiStatus> {
		return this.call<AgentPiStatus>("/api/pi/status");
	}

	/** GET /api/pi/sessions/{device}/{sessionId}/tail?lines=N — newest-last line
	 *  list of a session transcript (preview text only). */
	piSessionTail(device: string, sessionId: string, lines?: number): Promise<AgentPiTail> {
		return this.call<AgentPiTail>(
			`/api/pi/sessions/${encodeURIComponent(device)}/${encodeURIComponent(sessionId)}/tail`,
			"GET",
			lines != null ? { lines } : undefined,
		);
	}

	// ------------------------------------------------ pi deploy surface ----
	// agent v0.8.0 — the pi SERVICE (spawning) surface, complementing the
	// observational /api/pi/status + tail reads above. Pi is NOT a managed
	// agent-lifecycle service: no systemd units — spawning hands a device a
	// tmux session (or rpc-pipe fallback) rooted at a chosen working dir.

	/** GET /api/pi/devices — one entry per pi-sync device (session counts
	 *  included; the per-device session LISTS still come from /api/pi/status). */
	piDevices(): Promise<AgentPiDevicesResponse> {
		return this.call<AgentPiDevicesResponse>("/api/pi/devices");
	}

	/** GET /api/pi/devices/{device}/dirs?path=<abs> — the subdirectory listing
	 *  of one absolute path on the device (directory-picker backing store).
	 *  `parent` is null at the listing's root (no '..' step available). */
	piDirs(device: string, path: string): Promise<AgentPiDirsResponse> {
		return this.call<AgentPiDirsResponse>(
			`/api/pi/devices/${encodeURIComponent(device)}/dirs`,
			"GET",
			{ path },
		);
	}

	/** POST /api/pi/sessions {device, cwd} — spawn a pi coding session rooted
	 *  at `cwd` on the device (201: spawned 'tmux' | 'rpc-pipe'; error body
	 *  carries {error} which surfaces as a typed ArthurApiError). */
	piSpawn(device: string, cwd: string): Promise<AgentPiSpawnResult> {
		return this.call<AgentPiSpawnResult>(
			"/api/pi/sessions",
			"POST",
			undefined,
			{ device, cwd },
		);
	}

	/** POST /api/pi/terminal-sessions {device, cwd} — agent v0.8.2: launch the
	 *  `pi-ahp-tty` supervisor (the AHP terminal-registering pi session) on a
	 *  device so the plugin can attach a live terminal. The supervisor creates
	 *  the session and registers an externally-fed `ahp-terminal:/<id>`
	 *  channel; the plugin polls the AHP catalogue for the new terminal-bearing
	 *  session. 201 → the spawn result; any 4xx/5xx rejects with a typed
	 *  ArthurApiError carrying the server's `error` message verbatim
	 *  (422 'pi-ahp-tty not available on <device>' / 503 'device offline' /
	 *  502 launch failed). Nothing is spawned on 422. */
	piTerminalSpawn(device: string, cwd: string): Promise<AgentPiTerminalSpawnResult> {
		return this.call<AgentPiTerminalSpawnResult>(
			"/api/pi/terminal-sessions",
			"POST",
			undefined,
			{ device, cwd },
		);
	}
}

// ------------------------------------------------- pi deploy surface types ----

/** One pi-sync device of GET /api/pi/devices (agent v0.8.0). `self` marks the
 *  machine the agent itself runs on; `ssh` is the config's ssh mapping
 *  ("user@host" or bare host) used to infer the device's home root. */
export interface AgentPiDeviceEntry {
	id: string;
	hostname?: string | null;
	/** Recent feed heard from? false → offline (no feed in 5min). */
	online: boolean;
	/** Usable for dirs/spawn: feed-fresh OR ssh-reachable (agent v0.8.1).
	 *  Distinguishes 'offline, no feed' (grey) from 'no feed but ssh ok'. */
	reachable: boolean;
	/** True for the machine the agent runs on. */
	self?: boolean;
	/** The config ssh mapping, e.g. "benjaminmatthys@mac.home" or "ulysse". */
	ssh?: string | null;
	sessionsActive: number;
	sessionsTotal: number;
}

/** GET /api/pi/devices response. */
export interface AgentPiDevicesResponse {
	devices: AgentPiDeviceEntry[];
}

/** GET /api/pi/devices/{device}/dirs?path=<abs> — one directory listing. */
export interface AgentPiDirsResponse {
	device: string;
	/** The listed (absolute) path — echoed by the agent. */
	path: string;
	/** Subdirectory NAMES of `path` (files excluded). */
	dirs: string[];
	/** Absolute parent path, null when there is none (listing root). */
	parent: string | null;
}

/** POST /api/pi/sessions — 201 result. `spawned` names the transport
 *  ('tmux' or 'rpc-pipe'); `window` is the tmux window when applicable and
 *  `hint` a free-form human pointer for the notice. */
export interface AgentPiSpawnResult {
	device: string;
	cwd: string;
	spawned: string;
	window?: string | null;
	hint?: string | null;
}

/** POST /api/pi/terminal-sessions — 201 result (agent v0.8.2). `spawned` is
 *  always 'pi-ahp-tty'; `detail.log` is the supervisor's log path (absolute on
 *  `self`, ~/...-relative on remote) surfaced on a poll timeout, and
 *  `detail.pid` the supervisor's PID when captured (else null).
 *
 *  `sessionId` (agent v0.8.3) is the EXACT `ahp-session:/<id>` URI the
 *  supervisor resumed or minted — null when the launch log printed no
 *  session URI inside the agent's extraction window. OPTIONAL: an older
 *  agent omits the field entirely, so callers must tolerate its absence
 *  (the picker falls back to its cwd-prefix heuristic). */
export interface AgentPiTerminalSpawnDetail {
	log: string;
	pid: number | null;
	sessionId?: string | null;
}

export interface AgentPiTerminalSpawnResult {
	device: string;
	cwd: string;
	spawned: "pi-ahp-tty";
	detail: AgentPiTerminalSpawnDetail;
}

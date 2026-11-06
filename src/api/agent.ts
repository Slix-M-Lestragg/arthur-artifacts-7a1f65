/**
 * Client for the arthur-agent companion service (server/README-install.md,
 * default port 8766) — API v0.5.0 service-registry surface. Services are
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
	/** systemd active AND the port answers the probe path. */
	up: boolean;
	uptime?: number | null;
	unit?: string;
	live?: boolean;
}

/** One registered service with its live instance list. */
export interface AgentService {
	id: string;
	name?: string;
	/** Service-level state: any instance up. */
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

/** POST /api/services/{svc}/stop — results over ALL active instances. */
export interface AgentServiceStopResult {
	action: "stop";
	result: string;
	stopped: string[];
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

/** Agent version this plugin build was written against — mismatch → banner. */
export const AGENT_VERSION = "0.5.0";

/** GET /health — unauthenticated {ok:true, version}; distinguishes "agent down" from "bad token". */
export interface AgentHealth {
	ok: boolean;
	version?: string;
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
	): Promise<T> {
		let resp;
		try {
			resp = await this.requester.request({
				url: this.url(path, params),
				method,
				headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
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
	 * service; the server refuses with 409 while a generation runs unless
	 * force=true.
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
	 */
	async serviceSpawn(svc: string): Promise<AgentSpawnResult> {
		return this.call<AgentSpawnResult>(
			`/api/services/${encodeURIComponent(svc)}/instances`,
			"POST",
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
}

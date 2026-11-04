/**
 * Client for the arthur-agent companion service (PLAN §2.2, default port
 * 8766): lifecycle control for ComfyUI instances + audit log, all token
 * authenticated under /api/. The agent may legitimately be unreachable
 * (server down, systemd restart) — every failure surfaces as a typed
 * ArthurApiError (status 0 for network-level failures).
 */
import { ArthurApiError, Requester, ensureOk } from "./transport";

/** GET /api/status — handshake + per-instance runtime summary. */
export interface AgentStatus {
	version: string;
	instances: AgentInstanceSummary[];
	host_uptime?: number;
}

export interface AgentInstanceSummary {
	id: string;
	up: boolean;
	uptime?: number | null;
	port?: number | null;
	gpu?: number | null;
}

/** GET /api/instances — instance registry (configured, not necessarily up). */
export interface AgentInstancesResponse {
	instances: Array<{
		id: string;
		port: number;
		gpu: number;
		/** Raw launch command from the agent's instance map, if exposed. */
		start?: string;
	}>;
}

/** GET /api/instances/{id}/status — runtime status incl. port liveness probe. */
export interface AgentInstanceStatus {
	id: string;
	up: boolean;
	port: number;
	gpu: number;
	/** "listening" | "down" | … — exact vocabulary depends on the probe result. */
	port_state?: string;
	pid?: number | null;
	uptime?: number | null;
}

/** GET /health — unauthenticated {ok:true}; distinguishes "agent down" from "bad token". */
export interface AgentHealth {
	ok: boolean;
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
		const resp = await this.requester.request({
			url: this.url(path, params),
			method,
			headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
		});
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

	/** GET /api/status — version + instance summary (gates lifecycle UI). */
	async status(): Promise<AgentStatus> {
		return this.call<AgentStatus>("/api/status");
	}

	/** GET /api/instances — configured instance registry. */
	async instances(): Promise<AgentInstancesResponse> {
		return this.call<AgentInstancesResponse>("/api/instances");
	}

	/** GET /api/instances/{id}/status — runtime status with port probe. */
	async instanceStatus(id: string): Promise<AgentInstanceStatus> {
		return this.call<AgentInstanceStatus>(
			`/api/instances/${encodeURIComponent(id)}/status`,
		);
	}

	/** POST /api/instances/{id}/start — idempotent start. */
	async start(id: string): Promise<unknown> {
		return this.call(
			`/api/instances/${encodeURIComponent(id)}/start`,
			"POST",
		);
	}

	/**
	 * POST /api/instances/{id}/stop — graceful stop; the server refuses while a
	 * generation is running unless force=true (→ ?force=1).
	 */
	async stop(id: string, force?: boolean): Promise<unknown> {
		return this.call(
			`/api/instances/${encodeURIComponent(id)}/stop`,
			"POST",
			force ? { force: 1 } : undefined,
		);
	}

	/** POST /api/instances/{id}/restart — stop → wait port free → start, bounded. */
	async restart(id: string): Promise<unknown> {
		return this.call(
			`/api/instances/${encodeURIComponent(id)}/restart`,
			"POST",
		);
	}
}

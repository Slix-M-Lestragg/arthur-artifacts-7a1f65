/**
 * Client for the ostris/ai-toolkit HTTP UI (port 8675, Bearer AI_TOOLKIT_AUTH).
 *
 * Shape-verified against the live server (docs/RESEARCH-DIGEST.md). Important
 * quirk: every control route is a GET with side effects — they are wrapped
 * here in explicit named methods so UI code never builds these URLs itself.
 */
import { ArthurApiError, Requester, ensureOk } from "./transport";

/** GET /api/jobs row (verified live). */
export interface AiToolkitJob {
	id: string;
	name: string;
	/** Comma-separated GPU index list, e.g. "0" or "0,1". */
	gpu_ids: string;
	/** JSON string of the job config (parse on demand). */
	job_config: string;
	created_at: string;
	updated_at: string;
	status: AiToolkitJobStatus;
	stop: boolean;
	return_to_queue: boolean;
	step: number;
	total_steps: number | null;
	info?: string | null;
	speed_string: string;
	queue_position: number | null;
	pid: number | null;
	job_type: string | null;
	job_ref: string | null;
	save_now: boolean;
	sample_now: boolean;
}

export type AiToolkitJobStatus =
	| "queued"
	| "running"
	| "stopping"
	| "stopped"
	| "error"
	| "completed";

export interface AiToolkitJobsResponse {
	jobs: AiToolkitJob[];
}

/** GET /api/queue (verified live) — per-GPU-set queues. */
export interface AiToolkitQueue {
	queues: Array<{
		id: number | string;
		gpu_ids: string;
		is_running: boolean;
	}>;
}

/** GET /api/gpu (verified live) — nvidia-smi derived. VRAM in MB. */
export interface AiToolkitGpuStats {
	hasNvidiaSmi: boolean;
	gpus: Array<{
		index: number;
		name: string;
		driverVersion: string;
		temperature: number;
		utilization: { gpu: number; memory: number };
		memory: { total: number; free: number; used: number };
		power: { draw: number; limit: number };
		clocks: { graphics: number; memory: number };
		fan: { speed: number };
	}>;
}

/** GET /api/cpu (verified live) — VRAM/RAM fields are MiB. */
export interface AiToolkitCpuStats {
	name: string;
	cores: number;
	temperature: number;
	totalMemory: number;
	availableMemory: number;
	freeMemory: number;
	currentLoad: number;
}

/** GET /api/jobs/{id}/loss (verified live) — chartable metric series. */
export interface AiToolkitLossResponse {
	keys: string[];
	since_step: number;
	series: Record<string, Array<{ step: number; value: number }>>;
}

/** GET /api/jobs/{id}/log (verified live) — incremental log tail. */
export interface AiToolkitLogResponse {
	log: string;
}

export class AiToolkitClient {
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
		params?: Record<string, string | number | undefined>,
	): Promise<T> {
		const resp = await this.requester.request({
			url: this.url(path, params),
			headers: this.authHeaders(),
		});
		await ensureOk(resp);
		return resp.json() as T;
	}

	/**
	 * GET with side effects (ai-toolkit control routes are GETs). Wrapped as
	 * named methods only — never call raw from UI code.
	 */
	private async callMutation<T>(
		path: string,
		params?: Record<string, string | number | undefined>,
	): Promise<T> {
		return this.call<T>(path, params);
	}

	private authHeaders(): Record<string, string> {
		return this.token ? { Authorization: `Bearer ${this.token}` } : {};
	}

	/** GET /api/jobs — all jobs; status filters server-side. */
	async jobs(opts: { status?: string } = {}): Promise<AiToolkitJobsResponse> {
		return this.call<AiToolkitJobsResponse>("/api/jobs", { status: opts.status });
	}

	/** GET /api/queue — per-GPU-set queues + running state. */
	async queueList(): Promise<AiToolkitQueue> {
		return this.call<AiToolkitQueue>("/api/queue");
	}

	/** GET /api/jobs/{id} — single job (shape may be {job} or the raw row). */
	async job(id: string): Promise<unknown> {
		return this.call<any>(`/api/jobs/${encodeURIComponent(id)}`);
	}

	async jobStart(id: string): Promise<unknown> {
		return this.callMutation(`/api/jobs/${encodeURIComponent(id)}/start`);
	}

	/** Graceful stop (SIGINT); use jobKill for force. */
	async jobStop(id: string): Promise<unknown> {
		return this.callMutation(`/api/jobs/${encodeURIComponent(id)}/stop`);
	}

	async jobKill(id: string): Promise<unknown> {
		return this.callMutation(`/api/jobs/${encodeURIComponent(id)}/kill`);
	}

	async jobDelete(id: string): Promise<unknown> {
		return this.callMutation(`/api/jobs/${encodeURIComponent(id)}/delete`);
	}

	/** Mark a crashed (already-dead) job as stopped. */
	async jobMarkStopped(id: string): Promise<unknown> {
		return this.callMutation(`/api/jobs/${encodeURIComponent(id)}/mark_stopped`);
	}

	/** GET /api/jobs/{id}/log?offset= — incremental tail; returns the full log plus new data. */
	async jobLog(id: string, offset: number): Promise<AiToolkitLogResponse> {
		return this.call<AiToolkitLogResponse>(
			`/api/jobs/${encodeURIComponent(id)}/log`,
			{ offset },
		);
	}

	/** GET /api/jobs/{id}/loss?since_step= — incremental metric series for charts. */
	async jobLoss(id: string, sinceStep: number): Promise<AiToolkitLossResponse> {
		return this.call<AiToolkitLossResponse>(
			`/api/jobs/${encodeURIComponent(id)}/loss`,
			{ since_step: sinceStep },
		);
	}

	/** GET /api/queue/{id}/start — resume a paused GPU-set queue. */
	async queueStart(id: string | number): Promise<unknown> {
		return this.callMutation(`/api/queue/${encodeURIComponent(String(id))}/start`);
	}

	/** GET /api/queue/{id}/stop — pause a GPU-set queue. */
	async queueStop(id: string | number): Promise<unknown> {
		return this.callMutation(`/api/queue/${encodeURIComponent(String(id))}/stop`);
	}

	/** GET /api/gpu — per-GPU utilization/VRAM/power/temp. */
	async gpuStats(): Promise<AiToolkitGpuStats> {
		return this.call<AiToolkitGpuStats>("/api/gpu");
	}

	/** GET /api/cpu — CPU load + RAM. */
	async cpuStats(): Promise<AiToolkitCpuStats> {
		return this.call<AiToolkitCpuStats>("/api/cpu");
	}
}

// Re-export so callers catching offline/bad-token states can reference the type
// without importing from transport directly.
export { ArthurApiError };

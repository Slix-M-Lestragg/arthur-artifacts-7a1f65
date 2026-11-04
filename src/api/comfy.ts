/**
 * Client for ComfyUI's HTTP API (one per instance port, e.g. 8188/8189).
 *
 * Shape-verified against ComfyUI master (server.py, comfy_execution/jobs.py)
 * and docs/PLAN.md. WS event handling lives in connection.ts — this class is
 * HTTP only.
 */
import { HttpResponse, Requester, ensureOk } from "./transport";

/** GET /system_stats — devices[] carries VRAM totals per visible GPU. */
export interface ComfyDevice {
	name: string;
	/** "cuda" | "cpu" … */
	type?: string;
	index?: number;
	vram_total: number;
	vram_free: number;
	torch_vram_total?: number;
	torch_vram_free?: number;
}

export interface SystemStats {
	system: {
		os?: string;
		ram_total?: number;
		ram_free?: number;
		comfyui_version?: string;
		python_version?: string;
		[i: string]: unknown;
	};
	devices: ComfyDevice[];
}

/** GET /queue — running + pending prompts (sensitive data stripped by server). */
export interface QueueResponse {
	queue_running: any[];
	queue_pending: any[];
}

/**
 * GET /api/jobs — unified job row across queue + history (ComfyUI's newer
 * paginated API, server.py get_jobs). Statuses: pending | in_progress |
 * completed | failed | cancelled.
 */
export interface ComfyJob {
	id: string;
	status: string;
	priority?: number;
	create_time?: number | null;
	execution_start_time?: number | null;
	execution_end_time?: number | null;
	execution_error?: any | null;
	outputs_count?: number;
	previewable_outputs_count?: number;
	preview_output?: any | null;
	workflow_id?: string | null;
	/** Present on single-job GET /api/jobs/{id} (normalize_history_item include_outputs). */
	outputs?: any;
}

export interface ComfyJobsResponse {
	jobs: ComfyJob[];
	pagination?: {
		offset: number;
		limit: number | null;
		total: number;
		has_more: boolean;
	};
}

/** GET /history — keyed by prompt_id. */
export interface ComfyHistoryResponse {
	[promptId: string]: any;
}

export class ComfyUIClient {
	constructor(
		private readonly host: string,
		private readonly port: number,
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

	private async call<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
		const resp = await this.requester.request({ url: this.url(path, params) });
		await ensureOk(resp);
		return resp.json() as T;
	}

	/** GET /system_stats — GPU count + VRAM total/free per device. */
	async systemStats(): Promise<SystemStats> {
		return this.call<SystemStats>("/system_stats");
	}

	/** GET /queue — running + pending queue items. */
	async queue(): Promise<QueueResponse> {
		return this.call<QueueResponse>("/queue");
	}

	/**
	 * GET /api/jobs — unified job list with filter + pagination.
	 * status is a comma-separated list of: pending, in_progress, completed,
	 * failed, cancelled.
	 */
	async jobs(
		opts: { status?: string; limit?: number; offset?: number } = {},
	): Promise<ComfyJobsResponse> {
		return this.call<ComfyJobsResponse>("/api/jobs", {
			status: opts.status,
			limit: opts.limit,
			offset: opts.offset,
		});
	}

	/** GET /api/jobs/{id} — single job, includes normalized outputs. */
	async job(id: string): Promise<ComfyJob> {
		return this.call<ComfyJob>(`/api/jobs/${encodeURIComponent(id)}`);
	}

	/**
	 * POST /api/jobs/{id}/cancel — cancel by unified job id (running → targeted
	 * interrupt, queued → dequeue, history → no-op). Prefer this over /interrupt
	 * for UI actions; /interrupt stays available for prompt_id-targeted cancel.
	 */
	async cancelJob(id: string): Promise<boolean> {
		const resp = await this.requester.request(
			{ url: this.url(`/api/jobs/${encodeURIComponent(id)}/cancel`), method: "POST" },
		);
		return statusConfirmed(resp);
	}

	/**
	 * POST /interrupt {prompt_id?} — interrupt the running execution; with a
	 * prompt_id it also removes that pending prompt from the queue.
	 */
	async interrupt(promptId?: string): Promise<boolean> {
		const resp = await this.requester.request({
			url: this.url("/interrupt"),
			method: "POST",
			body: promptId ? { prompt_id: promptId } : {},
		});
		return statusConfirmed(resp);
	}

	/** POST /queue {delete:[ids]} — remove specific queued prompts. */
	async deleteQueueItems(ids: string[]): Promise<boolean> {
		const resp = await this.requester.request({
			url: this.url("/queue"),
			method: "POST",
			body: { delete: ids },
		});
		return statusConfirmed(resp);
	}

	/** POST /queue {clear:true} — drop every pending prompt. */
	async clearQueue(): Promise<boolean> {
		const resp = await this.requester.request({
			url: this.url("/queue"),
			method: "POST",
			body: { clear: true },
		});
		return statusConfirmed(resp);
	}

	/** POST /free {unload_models, free_memory} — release VRAM. */
	async free(unloadModels: boolean, freeMemory: boolean): Promise<boolean> {
		const resp = await this.requester.request({
			url: this.url("/free"),
			method: "POST",
			body: { unload_models: unloadModels, free_memory: freeMemory },
		});
		return statusConfirmed(resp);
	}

	/** GET /models/{folder} — list of model filenames in a folder. */
	async models(folder: string): Promise<string[]> {
		return this.call<string[]>(
			`/models/${encodeURIComponent(folder)}`,
		);
	}

	/** GET /history?max_items=n — recent finished executions keyed by prompt_id. */
	async history(maxItems?: number): Promise<ComfyHistoryResponse> {
		return this.call<ComfyHistoryResponse>("/history", {
			max_items: maxItems,
		});
	}
}

/** Normalize mutation responses: ComfyUI returns 200 on success, 4xx + {error}. */
async function statusConfirmed(resp: HttpResponse): Promise<boolean> {
	await ensureOk(resp); // turns 4xx/5xx into a typed error with the server's message
	return true;
}
